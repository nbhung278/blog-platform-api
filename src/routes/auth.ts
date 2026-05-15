import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { hash, compare } from "bcrypt";
import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { prisma } from "../db";
import { authMiddleware, tryGetUser, type JWTPayload } from "../middleware/auth";
import { disconnectUser } from "../lib/realtime";
import {
	loginRateLimit,
	ipRateLimit,
	recordLoginFailure,
	recordLoginSuccess,
	getClientIp,
} from "../middleware/rate-limit";
import {
	ADMIN_PANEL_PERMISSIONS,
	ROLE_KEYS,
	expandPermissions,
	type PermissionKey,
} from "../lib/permissions";
import { loadUserRolesAndPermissions } from "../lib/user-permissions";
import { env } from "../lib/env";
import { setPrivateNoStore } from "../lib/cache-headers";
import {
	bumpTokenVersion,
	consumeAndRotateRefreshToken,
	issueAccessToken,
	issueTokenPair,
	revokeRefreshToken,
} from "../lib/tokens";
import {
	CSRF_HEADER,
	clearAuthCookies,
	csrfTokensMatch,
	getCsrfCookie,
	getRefreshCookie,
	rotateAccessCookie,
	rotateCsrfCookie,
	rotateRefreshCookie,
	setAuthCookies,
} from "../lib/cookies";
import { isAllowedMediaUrl } from "../lib/url-allowlist";
import { sendEmail } from "../lib/email";
import { buildOtpEmail } from "../lib/email-templates";
import { canResend, invalidateOtpsForEmail, issueOtp, verifyOtp } from "../lib/otp";
import { isKnownDevice, trustDevice } from "../lib/device";
import { logger } from "../lib/logger";
import { redis } from "../lib/redis";
import {
	buildAuthUrl,
	buildState,
	exchangeCode,
	fetchUserInfo,
	getGoogleConfig,
	verifyState,
} from "../lib/google-oauth";

export const authRoutes = new Hono<{ Variables: { user: JWTPayload } }>();

export const passwordSchema = z
	.string()
	.min(12, "Password must be at least 12 characters")
	.regex(/[A-Z]/, "Must contain an uppercase letter")
	.regex(/[a-z]/, "Must contain a lowercase letter")
	.regex(/[0-9]/, "Must contain a number");

const registerSchema = z.object({
	email: z.string().email(),
	password: passwordSchema,
	name: z.string().min(1),
	username: z
		.string()
		.min(3)
		.max(30)
		.regex(/^[a-z0-9-]+$/),
});

const loginSchema = z.object({
	email: z.string().email(),
	password: z.string(),
});

const setupSchema = z.object({
	email: z.string().email(),
	password: passwordSchema,
	name: z.string().min(1),
	username: z
		.string()
		.min(3)
		.max(30)
		.regex(/^[a-z0-9-]+$/),
});

const changePasswordSchema = z.object({
	currentPassword: z.string(),
	newPassword: passwordSchema,
});

class SetupAlreadyCompletedError extends Error {}

function clientContext(c: Context) {
	const rawIp = getClientIp(c);
	const ip = rawIp === "unknown" ? null : rawIp;
	const userAgent = c.req.header("user-agent") || null;
	return { ip, userAgent };
}

// Pre-computed bcrypt hash of a random string. Used to make /login spend the
// same wall-time on a missing-user path as on a wrong-password path. Without
// this, `bcrypt.compare` only runs when the user exists, leaking ~30ms of
// timing signal that lets attackers enumerate accounts.
const DUMMY_PASSWORD_HASH = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8cLh5GxqCkB5rIo1NYHSZv1VfM0vBu";

// Public: check if setup wizard should be shown (no users yet)
authRoutes.get("/setup-status", async (c) => {
	const userCount = await prisma.user.count();
	return c.json({ needsSetup: userCount === 0 });
});

// Public: bootstrap first super_admin. Only works when DB has zero users AND
// (if SETUP_TOKEN is configured) the caller echoes the install token so
// whoever lands on the endpoint after a DB reset can't win a race.
authRoutes.post(
	"/setup",
	ipRateLimit({ keyPrefix: "setup", limit: 5, windowSeconds: 60 * 15 }),
	zValidator("json", setupSchema),
	async (c) => {
		if (env.SETUP_TOKEN) {
			const provided = c.req.header("x-setup-token");
			if (!provided || provided !== env.SETUP_TOKEN) {
				return c.json({ error: "Setup not allowed" }, 403);
			}
		}
		const body = c.req.valid("json");
		const superRole = await prisma.role.findUnique({
			where: { key: ROLE_KEYS.SUPER_ADMIN },
		});
		if (!superRole) {
			return c.json({ error: "super_admin role missing — run db:seed first" }, 500);
		}

		const passwordHash = await hash(body.password, 10);

		// Serializable transaction: count + create must be atomic so two
		// concurrent /setup requests can't both succeed when DB is empty.
		let user: { id: string; email: string; username: string; tokenVersion: number };
		try {
			user = await prisma.$transaction(
				async (tx) => {
					const count = await tx.user.count();
					if (count > 0) {
						throw new SetupAlreadyCompletedError();
					}
					return tx.user.create({
						data: {
							email: body.email,
							username: body.username,
							name: body.name,
							passwordHash,
							roles: { create: [{ roleId: superRole.id }] },
						},
						select: { id: true, email: true, username: true, tokenVersion: true },
					});
				},
				{ isolationLevel: "Serializable" },
			);
		} catch (err) {
			if (err instanceof SetupAlreadyCompletedError) {
				return c.json({ error: "Setup already completed" }, 410);
			}
			throw err;
		}

		const pair = await issueTokenPair({ ...user, mustChangePassword: false }, clientContext(c));
		setAuthCookies(c, { accessToken: pair.accessToken, refreshToken: pair.refreshToken });
		return c.json(
			{
				user: {
					id: user.id,
					email: user.email,
					username: user.username,
					name: body.name,
					roles: pair.roles,
					permissions: pair.permissions,
					mustChangePassword: false,
				},
			},
			201,
		);
	},
);

// Registration is a two-step flow: /register creates the user with
// emailVerified=false and issues an OTP; /verify-signup-otp checks the code
// and only then sets cookies. We persist the user up-front (instead of
// staging in Redis) so the username/email uniqueness check is enforced by
// the DB constraint and not racy across parallel signups for the same email.
authRoutes.post(
	"/register",
	ipRateLimit({ keyPrefix: "register", limit: 5, windowSeconds: 60 * 60 }),
	zValidator("json", registerSchema),
	async (c) => {
		if (!env.ALLOW_REGISTRATION) {
			return c.json({ error: "Registration is not open" }, 403);
		}

		const { email, password, name, username } = c.req.valid("json");

		const passwordHash = await hash(password, 10);

		const authorRole = await prisma.role.findUnique({
			where: { key: ROLE_KEYS.AUTHOR },
			select: { id: true },
		});
		if (!authorRole) {
			return c.json({ error: "author role missing — run db:seed first" }, 500);
		}

		// Race-free uniqueness: relying on the DB unique constraint instead of a
		// findFirst+create pair, which has a window where two parallel requests
		// both pass the lookup. We catch P2002 (unique violation) and turn it
		// into a 400 — same UX as the old check, no race.
		let user;
		try {
			user = await prisma.user.create({
				data: {
					email,
					passwordHash,
					name,
					username,
					emailVerified: false,
					roles: { create: [{ roleId: authorRole.id }] },
				},
				select: {
					id: true,
					email: true,
					username: true,
				},
			});
		} catch (err) {
			if (
				err &&
				typeof err === "object" &&
				"code" in err &&
				(err as { code?: string }).code === "P2002"
			) {
				return c.json({ error: "Email or username already taken" }, 400);
			}
			throw err;
		}

		const { token, code } = await issueOtp("signup", { userId: user.id, email: user.email });
		const tpl = buildOtpEmail("signup", code);
		const result = await sendEmail({
			to: user.email,
			subject: tpl.subject,
			html: tpl.html,
			text: tpl.text,
			tags: [{ name: "purpose", value: "signup" }],
		});
		if (!result.ok && result.reason !== "disabled") {
			// Roll back the user row so the same email can retry without
			// hitting P2002 "email already taken" next time. We always log the
			// rollback error path because losing this cleanup leaves the
			// account in a half-created state.
			await prisma.user.delete({ where: { id: user.id } }).catch((err) => {
				logger.error(
					{ err, userId: user.id },
					"[register] failed to roll back user after email failure",
				);
			});
			if (result.reason === "suppressed") {
				// Recipient is on the bounce/complaint suppression list. Don't
				// leak that fact ("This email previously bounced") — that
				// reveals whether anyone has ever bounced from this address.
				// Generic 400 keeps the response shape uniform with other bad
				// inputs.
				return c.json(
					{ error: "We can't send to this email address — please use a different one" },
					400,
				);
			}
			return c.json({ error: "Could not send verification email — please try again" }, 502);
		}

		return c.json(
			{
				requiresOtp: true,
				otpToken: token,
				email: user.email,
				// In dev with EMAIL_ENABLED=false, surface the code so the flow
				// stays usable without a real inbox. Never do this in prod.
				...(env.NODE_ENV !== "production" && !env.EMAIL_ENABLED ? { devCode: code } : {}),
			},
			202,
		);
	},
);

const verifySignupOtpSchema = z.object({
	otpToken: z.string().min(8),
	code: z.string().regex(/^\d{6}$/),
});

authRoutes.post(
	"/verify-signup-otp",
	ipRateLimit({ keyPrefix: "verify_signup", limit: 10, windowSeconds: 60 * 15 }),
	zValidator("json", verifySignupOtpSchema),
	async (c) => {
		const { otpToken, code } = c.req.valid("json");
		const result = await verifyOtp<{ userId: string; email: string }>("signup", otpToken, code);
		if (!result.ok) {
			return c.json({ error: "Invalid or expired code", code: result.reason.toUpperCase() }, 400);
		}

		const user = await prisma.user.findUnique({
			where: { id: result.payload.userId },
			select: {
				id: true,
				email: true,
				username: true,
				name: true,
				bio: true,
				avatarUrl: true,
				mustChangePassword: true,
				tokenVersion: true,
			},
		});
		if (!user) {
			return c.json({ error: "Account no longer exists" }, 410);
		}

		await prisma.user.update({
			where: { id: user.id },
			data: { emailVerified: true },
		});

		const ctx = clientContext(c);
		await trustDevice(user.id, ctx);

		const pair = await issueTokenPair(user, ctx);
		setAuthCookies(c, { accessToken: pair.accessToken, refreshToken: pair.refreshToken });
		return c.json(
			{
				user: {
					id: user.id,
					email: user.email,
					name: user.name,
					username: user.username,
					bio: user.bio,
					avatarUrl: user.avatarUrl,
					roles: pair.roles,
					permissions: pair.permissions,
					mustChangePassword: user.mustChangePassword,
				},
			},
			201,
		);
	},
);

authRoutes.post("/login", loginRateLimit(), zValidator("json", loginSchema), async (c) => {
	const { email, password } = c.req.valid("json");

	const user = await prisma.user.findUnique({ where: { email } });

	// Always run bcrypt against *something*, even when the user doesn't exist
	// or has no password set (e.g. Google-only account in Phase 2). This keeps
	// response time on the missing-user / no-password path within the same
	// distribution as the wrong-password path, blocking timing-based account
	// enumeration. Bool result on those branches is discarded.
	const valid = await compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);

	if (!user || !user.passwordHash || !valid) {
		// recordLoginFailure runs for every failure path (no user / no password
		// / wrong password) so timing stays uniform — otherwise the "no
		// password" branch (Google-only account) would skip a Redis round-trip
		// and become measurably faster, letting an attacker enumerate which
		// accounts are Google-only. The per-account lockout that builds up from
		// this counter is a feature for accounts with passwords; for Google-only
		// accounts it locks out password attempts that can never succeed anyway
		// — no functional harm, only timing parity.
		await recordLoginFailure(email);
		return c.json({ error: "Invalid credentials" }, 401);
	}

	const ctx = clientContext(c);

	// Admins skip the device step-up: they sign in from work/home/oncall
	// machines often enough that the email round-trip becomes friction
	// rather than security. The pool is small and password-protected.
	// We pass `userRolesPerms` into issueTokenPair below to avoid a second
	// DB query for the same data.
	const userRolesPerms = await loadUserRolesAndPermissions(user.id);
	const isAdmin = userRolesPerms.permissions.some((p) => ADMIN_PANEL_PERMISSIONS.includes(p));

	// Device-bound step-up: if this IP+UA fingerprint has never confirmed an
	// OTP for this user, hold off on issuing cookies and send a one-time code
	// instead. Verified devices skip the extra step.
	if (!isAdmin && !(await isKnownDevice(user.id, ctx))) {
		// Drop any outstanding login OTP for this email so a code we mailed
		// minutes ago can't still be used from a stale tab.
		await invalidateOtpsForEmail("login", user.email);
		const { token, code } = await issueOtp("login", { userId: user.id, email: user.email });
		const tpl = buildOtpEmail("login", code);
		const result = await sendEmail({
			to: user.email,
			subject: tpl.subject,
			html: tpl.html,
			text: tpl.text,
			tags: [{ name: "purpose", value: "login" }],
		});
		if (!result.ok && result.reason !== "disabled") {
			return c.json({ error: "Could not send verification email — please try again" }, 502);
		}
		// Don't record this as login success yet — only verify-login-otp should
		// reset the per-account backoff counter.
		return c.json(
			{
				requiresOtp: true,
				otpToken: token,
				email: user.email,
				...(env.NODE_ENV !== "production" && !env.EMAIL_ENABLED ? { devCode: code } : {}),
			},
			202,
		);
	}

	await recordLoginSuccess(email);
	await trustDevice(user.id, ctx);
	const pair = await issueTokenPair(user, ctx, userRolesPerms);
	setAuthCookies(c, { accessToken: pair.accessToken, refreshToken: pair.refreshToken });

	return c.json({
		user: {
			id: user.id,
			email: user.email,
			name: user.name,
			username: user.username,
			bio: user.bio,
			avatarUrl: user.avatarUrl,
			roles: pair.roles,
			permissions: pair.permissions,
			mustChangePassword: user.mustChangePassword,
		},
	});
});

const verifyLoginOtpSchema = z.object({
	otpToken: z.string().min(8),
	code: z.string().regex(/^\d{6}$/),
	trustDevice: z.boolean().default(true),
});

authRoutes.post(
	"/verify-login-otp",
	ipRateLimit({ keyPrefix: "verify_login", limit: 10, windowSeconds: 60 * 15 }),
	zValidator("json", verifyLoginOtpSchema),
	async (c) => {
		const { otpToken, code, trustDevice: shouldTrust } = c.req.valid("json");
		const result = await verifyOtp<{ userId: string; email: string }>("login", otpToken, code);
		if (!result.ok) {
			return c.json({ error: "Invalid or expired code", code: result.reason.toUpperCase() }, 400);
		}

		const user = await prisma.user.findUnique({
			where: { id: result.payload.userId },
			select: {
				id: true,
				email: true,
				username: true,
				name: true,
				bio: true,
				avatarUrl: true,
				mustChangePassword: true,
				tokenVersion: true,
			},
		});
		if (!user) {
			return c.json({ error: "Account no longer exists" }, 410);
		}

		const ctx = clientContext(c);
		await recordLoginSuccess(user.email);
		// "Trust this device" lets the user opt out on public/shared machines.
		// When unchecked, next login from this fingerprint will OTP again.
		if (shouldTrust) {
			await trustDevice(user.id, ctx);
		}

		const pair = await issueTokenPair(user, ctx);
		setAuthCookies(c, { accessToken: pair.accessToken, refreshToken: pair.refreshToken });
		return c.json({
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
				username: user.username,
				bio: user.bio,
				avatarUrl: user.avatarUrl,
				roles: pair.roles,
				permissions: pair.permissions,
				mustChangePassword: user.mustChangePassword,
			},
		});
	},
);

const resendOtpSchema = z.object({
	otpToken: z.string().min(8),
	purpose: z.enum(["signup", "login", "forgot"]),
});

// Resend OTP. We don't re-derive the email from the request body — instead we
// look up the original OTP payload by token, so a caller can't ask us to mail
// a code to an address that wasn't part of the original request. Per-identifier
// throttle (in canResend) caps how often the same target can be emailed.
authRoutes.post(
	"/resend-otp",
	ipRateLimit({ keyPrefix: "resend_otp", limit: 10, windowSeconds: 60 * 15 }),
	zValidator("json", resendOtpSchema),
	async (c) => {
		const { otpToken, purpose } = c.req.valid("json");
		// Peek at the existing OTP without consuming it. verifyOtp would
		// increment the attempts counter on any non-match (including the
		// dummy code we'd have to pass), so we read the record directly.
		const raw = await redis.get(`otp:${purpose}:${otpToken}`);
		if (!raw) {
			return c.json({ error: "Session expired — please start over" }, 410);
		}
		let payload: { email?: string; userId?: string };
		try {
			payload = JSON.parse(raw);
		} catch {
			return c.json({ error: "Session expired — please start over" }, 410);
		}
		const targetEmail = payload.email;
		if (!targetEmail) {
			return c.json({ error: "Session expired — please start over" }, 410);
		}

		if (!(await canResend(purpose, targetEmail))) {
			return c.json({ error: "Too many resend requests — try again later" }, 429);
		}

		// Drop the old token so the user can't keep trying both. New token
		// returned to the client.
		await redis.del(`otp:${purpose}:${otpToken}`);
		const fresh = await issueOtp(purpose, {
			...(payload.userId ? { userId: payload.userId } : {}),
			email: targetEmail,
		});
		const tpl = buildOtpEmail(purpose, fresh.code);
		const result = await sendEmail({
			to: targetEmail,
			subject: tpl.subject,
			html: tpl.html,
			text: tpl.text,
			tags: [{ name: "purpose", value: `${purpose}_resend` }],
		});
		if (!result.ok && result.reason !== "disabled") {
			return c.json({ error: "Could not send verification email — please try again" }, 502);
		}

		return c.json({
			otpToken: fresh.token,
			email: targetEmail,
			...(env.NODE_ENV !== "production" && !env.EMAIL_ENABLED ? { devCode: fresh.code } : {}),
		});
	},
);

const forgotPasswordSchema = z.object({
	email: z.string().email(),
});

// Forgot-password is intentionally a uniform 200 OK regardless of whether the
// email exists. Echoing "not found" leaks account existence and combined with
// /register would let attackers enumerate the user base. Two abuse vectors we
// also have to defend against:
//   1. Email-quota drain: free Resend tier is 100/day. Cap per-email via
//      canResend (5/h) AND per-IP via ipRateLimit (10/h).
//   2. Timing oracle: previous implementation took ~200ms longer for real
//      emails (DB write + Resend HTTP) than for missing ones (immediate
//      decoy). Easy to script. Fix: spend comparable wall time on the miss
//      path with a deliberate jittered delay.
authRoutes.post(
	"/forgot-password",
	// Per-IP cap only at this layer. Earlier we tried a per-(IP, email) cap via
	// keyExtractor, but ipRateLimit runs before zValidator so the body wasn't
	// parsed yet — every call collapsed to the same "anon" bucket. Per-email
	// throttle is enforced downstream via `canResend`, which uses Redis after
	// Zod has parsed the email.
	ipRateLimit({ keyPrefix: "forgot", limit: 10, windowSeconds: 60 * 60 }),
	zValidator("json", forgotPasswordSchema),
	async (c) => {
		const { email } = c.req.valid("json");
		// Always check canResend, even for non-existent emails — the SCAN/DB
		// query/Redis write should run on both paths so timing stays uniform.
		// Per-email throttle (5/h) applies regardless: an attacker can't sweep
		// candidate emails faster than 5/h per address.
		const canEmail = await canResend("forgot", email);
		const user = await prisma.user.findUnique({
			where: { email },
			select: { id: true, email: true, passwordHash: true },
		});

		const startedAt = Date.now();

		// Issue OTP + send mail only if account exists AND has a password
		// (Google-only accounts have no password to reset). Either way we
		// return the same response shape.
		if (canEmail && user && user.passwordHash) {
			// Drop any outstanding forgot-password OTP for this email so a
			// previously-mailed code can't still be redeemed from a stale tab
			// after a fresh request.
			await invalidateOtpsForEmail("forgot", user.email);
			const { token, code } = await issueOtp("forgot", {
				userId: user.id,
				email: user.email,
			});
			const tpl = buildOtpEmail("forgot", code);
			await sendEmail({
				to: user.email,
				subject: tpl.subject,
				html: tpl.html,
				text: tpl.text,
				tags: [{ name: "purpose", value: "forgot" }],
			});
			return c.json({
				ok: true,
				otpToken: token,
				...(env.NODE_ENV !== "production" && !env.EMAIL_ENABLED ? { devCode: code } : {}),
			});
		}

		// Account doesn't exist, has no password, or hit the per-email ceiling.
		// Pad the no-work path so its wall time overlaps with the real path's,
		// blocking timing oracle. The real path spends ~200-500ms on Resend
		// HTTP + DB write; we aim for the same window with a small random
		// jitter so even repeated requests don't betray a clean signature.
		const elapsed = Date.now() - startedAt;
		const targetDelay = 250 + Math.floor(Math.random() * 250); // 250-500ms
		const remaining = Math.max(0, targetDelay - elapsed);
		await new Promise((r) => setTimeout(r, remaining));

		// Return a token-shaped blob so the response can't be used to
		// distinguish cases. The frontend will fail verify on /reset-password
		// if it tries to use this decoy.
		const decoy = randomBytes(24).toString("base64url");
		return c.json({ ok: true, otpToken: decoy });
	},
);

const resetPasswordSchema = z.object({
	otpToken: z.string().min(8),
	code: z.string().regex(/^\d{6}$/),
	newPassword: passwordSchema,
});

authRoutes.post(
	"/reset-password",
	ipRateLimit({ keyPrefix: "reset_password", limit: 10, windowSeconds: 60 * 15 }),
	zValidator("json", resetPasswordSchema),
	async (c) => {
		const { otpToken, code, newPassword } = c.req.valid("json");
		const result = await verifyOtp<{ userId: string; email: string }>("forgot", otpToken, code);
		if (!result.ok) {
			return c.json({ error: "Invalid or expired code", code: result.reason.toUpperCase() }, 400);
		}

		const user = await prisma.user.findUnique({
			where: { id: result.payload.userId },
			select: { id: true },
		});
		if (!user) {
			return c.json({ error: "Account no longer exists" }, 410);
		}

		const passwordHash = await hash(newPassword, 10);
		await prisma.user.update({
			where: { id: user.id },
			data: { passwordHash, mustChangePassword: false },
		});

		// Anyone with a current session is forced to re-login — protects the
		// account if an attacker is also logged in when the password is reset.
		await bumpTokenVersion(user.id);
		disconnectUser(user.id, "password reset");

		return c.json({ ok: true });
	},
);

// Refresh endpoint: reads refresh token from HttpOnly cookie. CSRF is enforced
// here too because in prod cookies are SameSite=None (cross-subdomain SPA), so
// without the double-submit check a cross-site POST could trigger token
// rotation and DoS the legitimate session by revoking the previous refresh.
authRoutes.post(
	"/refresh",
	ipRateLimit({ keyPrefix: "refresh", limit: 60, windowSeconds: 60 * 15 }),
	async (c) => {
		// Double-submit CSRF: the cookie is sent automatically; the JS-readable
		// copy must be echoed in the X-CSRF-Token header. A cross-site form has
		// no way to read the cookie, so it can't replay this header.
		const csrfHeader = c.req.header(CSRF_HEADER);
		const csrfCookie = getCsrfCookie(c);
		if (!csrfTokensMatch(csrfHeader, csrfCookie)) {
			return c.json({ error: "CSRF token mismatch" }, 403);
		}

		const refreshToken = getRefreshCookie(c);
		if (!refreshToken) {
			return c.json({ error: "Missing refresh token" }, 401);
		}

		const result = await consumeAndRotateRefreshToken(refreshToken, clientContext(c));
		if (!result.ok) {
			// Don't echo the reason — it gives an attacker a signal about whether
			// they hit a real-but-revoked token vs. a non-existent one. Also clear
			// stale cookies so the client falls back to a clean login.
			clearAuthCookies(c);
			return c.json({ error: "Invalid refresh token" }, 401);
		}

		const user = await prisma.user.findUnique({
			where: { id: result.userId },
			select: {
				id: true,
				email: true,
				username: true,
				name: true,
				mustChangePassword: true,
				tokenVersion: true,
			},
		});
		if (!user) {
			clearAuthCookies(c);
			return c.json({ error: "User not found" }, 401);
		}

		// User was flagged for forced password change — make /refresh reject too,
		// not just protected routes. Otherwise client could keep sliding access
		// tokens forward indefinitely.
		if (user.mustChangePassword) {
			await revokeRefreshToken(result.newRefreshToken);
			clearAuthCookies(c);
			return c.json({ error: "Password change required", code: "PASSWORD_CHANGE_REQUIRED" }, 403);
		}

		const access = await issueAccessToken(user);
		rotateAccessCookie(c, access.token);
		rotateRefreshCookie(c, result.newRefreshToken);
		// Rotate CSRF too so a stolen CSRF cookie can't outlive the access token
		// it was paired with. Client's `invalidateCsrfCache` after /refresh
		// re-reads the new value lazily.
		rotateCsrfCookie(c);

		return c.json({
			user: {
				id: user.id,
				email: user.email,
				name: user.name,
				username: user.username,
				roles: access.roles,
				permissions: access.permissions,
				mustChangePassword: false,
			},
		});
	},
);

authRoutes.post(
	"/logout",
	ipRateLimit({ keyPrefix: "logout", limit: 30, windowSeconds: 60 * 15 }),
	async (c) => {
		const refreshToken = getRefreshCookie(c);
		const me = await tryGetUser(c);
		if (refreshToken) {
			await revokeRefreshToken(refreshToken);
		}
		clearAuthCookies(c);
		if (me) disconnectUser(me.sub, "logged out");
		return c.json({ success: true });
	},
);

authRoutes.post("/logout-all", authMiddleware, async (c) => {
	const me = c.get("user");
	await bumpTokenVersion(me.sub);
	clearAuthCookies(c);
	disconnectUser(me.sub, "logged out from all devices");
	return c.json({ success: true });
});

authRoutes.get("/me", authMiddleware, async (c) => {
	const jwtPayload = c.get("user");

	// Single round-trip: pull profile fields and the role→permission graph at
	// once. Previously this fired two queries back-to-back per /me call.
	const user = await prisma.user.findUnique({
		where: { id: jwtPayload.sub },
		select: {
			id: true,
			email: true,
			name: true,
			username: true,
			bio: true,
			avatarUrl: true,
			plan: true,
			mustChangePassword: true,
			// Used by the SPA to decide between /set-password (Google-only users
			// who never set one) and /change-password. We expose the boolean
			// only, never the hash itself.
			passwordHash: true,
			googleId: true,
			roles: {
				select: {
					role: {
						select: {
							key: true,
							permissions: { select: { permission: { select: { key: true } } } },
						},
					},
				},
			},
		},
	});

	if (!user) {
		return c.json({ error: "User not found" }, 404);
	}

	const roles = user.roles.map((ur) => ur.role.key);
	const permSet = new Set<PermissionKey>();
	for (const ur of user.roles) {
		for (const rp of ur.role.permissions) permSet.add(rp.permission.key as PermissionKey);
	}

	const { roles: _userRoles, passwordHash, googleId, ...profile } = user;
	setPrivateNoStore(c);
	return c.json({
		...profile,
		hasPassword: passwordHash !== null,
		googleLinked: googleId !== null,
		roles,
		permissions: expandPermissions(Array.from(permSet)),
	});
});

const updateMeSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	bio: z.string().max(500).nullable().optional(),
	avatarUrl: z
		.string()
		.url()
		.refine((u) => isAllowedMediaUrl(u), "avatarUrl host not allowed")
		.nullable()
		.optional(),
});

authRoutes.patch("/me", authMiddleware, zValidator("json", updateMeSchema), async (c) => {
	const me = c.get("user");
	const body = c.req.valid("json");

	const data: Record<string, unknown> = {};
	if (body.name !== undefined) data.name = body.name;
	if ("bio" in body) data.bio = body.bio;
	if ("avatarUrl" in body) data.avatarUrl = body.avatarUrl;

	if (Object.keys(data).length === 0) {
		return c.json({ error: "Nothing to update" }, 400);
	}

	const user = await prisma.user.update({
		where: { id: me.sub },
		data,
		select: { id: true, email: true, name: true, username: true, bio: true, avatarUrl: true },
	});

	return c.json(user);
});

authRoutes.post(
	"/change-password",
	authMiddleware,
	zValidator("json", changePasswordSchema),
	async (c) => {
		const me = c.get("user");
		const { currentPassword, newPassword } = c.req.valid("json");

		const user = await prisma.user.findUnique({ where: { id: me.sub } });
		if (!user) return c.json({ error: "User not found" }, 404);

		// Phase 2 will allow Google-only accounts with no passwordHash. For those
		// users, /change-password isn't the right entry point — they should set a
		// password via a dedicated endpoint instead.
		if (!user.passwordHash) {
			return c.json({ error: "This account has no password set", code: "NO_PASSWORD_SET" }, 400);
		}

		const valid = await compare(currentPassword, user.passwordHash);
		if (!valid) return c.json({ error: "Current password is incorrect" }, 400);

		if (currentPassword === newPassword) {
			return c.json({ error: "New password must differ from current" }, 400);
		}

		const passwordHash = await hash(newPassword, 10);
		await prisma.user.update({
			where: { id: user.id },
			data: { passwordHash, mustChangePassword: false },
		});

		// Revoke all existing tokens — force re-login on all devices.
		await bumpTokenVersion(user.id);
		clearAuthCookies(c);
		disconnectUser(user.id, "password changed");

		return c.json({ success: true });
	},
);

// ----- Google OAuth (Phase 2) -----

// Generate a unique, URL-safe username from a Google profile. The local-part
// of the email is the seed, lowercased + stripped of disallowed characters.
// If it collides with an existing username we append a 6-char random suffix
// — repeat until DB insert succeeds (handled by caller via P2002 retry).
function deriveUsername(email: string): string {
	const local = email.split("@")[0] ?? "user";
	const base = local
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 24);
	if (base.length < 3) return `user-${randomSuffix()}`;
	return base;
}

function randomSuffix(): string {
	// 3 random bytes → 6 hex chars. Math.random isn't strong enough here:
	// usernames are public, and a predictable suffix would let an attacker
	// pre-claim the names a victim is about to receive.
	return randomBytes(3).toString("hex");
}

// Start the OAuth dance. Issues a signed `state` cookie and redirects the
// browser to Google's consent screen. The state cookie is HttpOnly + SameSite
// Lax (Lax because Google's redirect back is a top-level navigation, which
// `Strict` would strip the cookie from).
authRoutes.get(
	"/google",
	ipRateLimit({ keyPrefix: "google_start", limit: 20, windowSeconds: 60 * 15 }),
	async (c) => {
		const config = getGoogleConfig();
		if (!config) {
			return c.json({ error: "Google sign-in not configured" }, 503);
		}
		const state = buildState();
		const url = buildAuthUrl(config, state);
		return c.redirect(url, 302);
	},
);

// OAuth callback. Verifies the state, exchanges the code for tokens, then
// looks up the user three ways before deciding whether to log in, link, or
// create. End result is the same as a password login: HttpOnly cookies set,
// browser redirected to the frontend.
authRoutes.get(
	"/google/callback",
	ipRateLimit({ keyPrefix: "google_callback", limit: 20, windowSeconds: 60 * 15 }),
	async (c) => {
		const config = getGoogleConfig();
		if (!config) {
			return c.json({ error: "Google sign-in not configured" }, 503);
		}

		const frontendUrl = env.FRONTEND_URL ?? env.APP_URL;
		const errorRedirect = (reason: string) =>
			c.redirect(
				`${frontendUrl}/login?error=google_oauth&reason=${encodeURIComponent(reason)}`,
				302,
			);

		const code = c.req.query("code");
		const state = c.req.query("state");
		const oauthError = c.req.query("error");

		if (oauthError) {
			logger.warn({ oauthError }, "[google] user denied or provider error");
			return errorRedirect(oauthError);
		}
		if (!code || !state) {
			return errorRedirect("missing_params");
		}
		if (!verifyState(state)) {
			return errorRedirect("invalid_state");
		}

		let tokens;
		let info;
		try {
			tokens = await exchangeCode(config, code);
			info = await fetchUserInfo(tokens.access_token);
		} catch (err) {
			logger.error({ err }, "[google] token exchange / userinfo failed");
			return errorRedirect("provider_error");
		}

		if (!info.email_verified) {
			// Google says the account hasn't verified its own email — we don't
			// want to inherit an unverified address into our trust model.
			return errorRedirect("email_not_verified");
		}

		const email = info.email.toLowerCase();
		const googleId = info.sub;

		// 1) Existing Google-linked account → straight login.
		let user = await prisma.user.findUnique({ where: { googleId } });

		// 2) Account exists by email but hasn't been linked yet → link now.
		if (!user) {
			const byEmail = await prisma.user.findUnique({ where: { email } });
			if (byEmail) {
				user = await prisma.user.update({
					where: { id: byEmail.id },
					data: {
						googleId,
						// If the existing account was unverified, Google has confirmed
						// the email, so we can promote it.
						emailVerified: true,
						// Backfill avatar only if user hasn't set one; never overwrite
						// a customized picture.
						...(byEmail.avatarUrl ? {} : { avatarUrl: info.picture ?? null }),
					},
				});
			}
		}

		// 3) Brand new user → create with Google identity.
		if (!user) {
			const authorRole = await prisma.role.findUnique({
				where: { key: ROLE_KEYS.AUTHOR },
				select: { id: true },
			});
			if (!authorRole) {
				logger.error("[google] author role missing — db:seed not run?");
				return errorRedirect("role_missing");
			}

			let username = deriveUsername(email);
			// Retry username collisions with a short suffix — we only loop a
			// handful of times so a pathological username space can't hang the
			// request. Unique violations from a parallel signup show up as P2002.
			for (let attempt = 0; attempt < 5; attempt++) {
				try {
					user = await prisma.user.create({
						data: {
							email,
							googleId,
							name: info.name || email.split("@")[0] || "User",
							username,
							avatarUrl: info.picture ?? null,
							emailVerified: true,
							roles: { create: [{ roleId: authorRole.id }] },
						},
					});
					break;
				} catch (err) {
					// Renamed from `code` to avoid shadowing the OAuth `code` query
					// param captured in the outer scope.
					const prismaErrorCode = (err as { code?: string }).code;
					if (prismaErrorCode === "P2002") {
						// Could be email OR username — re-fetch by email in case of
						// race, otherwise extend the username and try again.
						const existing = await prisma.user.findUnique({ where: { email } });
						if (existing) {
							// Race: another tab linked the same email. Use that row.
							user = await prisma.user.update({
								where: { id: existing.id },
								data: { googleId, emailVerified: true },
							});
							break;
						}
						username = `${deriveUsername(email)}-${randomSuffix()}`;
						continue;
					}
					throw err;
				}
			}

			if (!user) {
				return errorRedirect("could_not_create_account");
			}
		}

		// At this point `user` is final. Issue session cookies and trust the
		// current device — Google has already done the identity proof, so we
		// don't gate this behind an OTP step-up.
		//
		// Force the "web" cookie partition: the OAuth callback is a top-level
		// browser redirect from Google, so the X-App-Client header set by the
		// SPA isn't present. Without this override, setAuthCookies would fall
		// back to "admin" and the strix-blog.uk SPA would never see its session.
		const ctx = clientContext(c);
		await trustDevice(user.id, ctx);
		const pair = await issueTokenPair(user, ctx);
		setAuthCookies(c, { accessToken: pair.accessToken, refreshToken: pair.refreshToken }, "web");

		// Hop through a dedicated frontend page so the SPA can fetch /auth/me
		// and update its store before landing on the destination.
		return c.redirect(`${frontendUrl}/auth/google-success`, 302);
	},
);

const setPasswordSchema = z.object({
	newPassword: passwordSchema,
});

// Set a password for an account that doesn't have one yet — used by users
// who signed up via Google and now want a fallback credential. CSRF-protected
// because it's a state change that should never originate from a cross-site
// request.
authRoutes.post(
	"/set-password",
	authMiddleware,
	ipRateLimit({ keyPrefix: "set_password", limit: 10, windowSeconds: 60 * 60 }),
	zValidator("json", setPasswordSchema),
	async (c) => {
		const csrfHeader = c.req.header(CSRF_HEADER);
		const csrfCookie = getCsrfCookie(c);
		if (!csrfTokensMatch(csrfHeader, csrfCookie)) {
			return c.json({ error: "CSRF token mismatch" }, 403);
		}

		const me = c.get("user");
		const { newPassword } = c.req.valid("json");

		const user = await prisma.user.findUnique({
			where: { id: me.sub },
			select: { id: true, passwordHash: true },
		});
		if (!user) return c.json({ error: "User not found" }, 404);

		if (user.passwordHash) {
			// Already has a password — they should go through /change-password
			// instead, which requires the current password as a knowledge proof.
			return c.json(
				{ error: "Password already set — use change-password", code: "PASSWORD_ALREADY_SET" },
				400,
			);
		}

		const passwordHash = await hash(newPassword, 10);
		await prisma.user.update({
			where: { id: user.id },
			data: { passwordHash },
		});

		// Don't revoke other sessions: setting a password for the first time
		// isn't a security boundary the way /change-password is.

		return c.json({ ok: true });
	},
);
