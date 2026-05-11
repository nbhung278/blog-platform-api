import { env } from "./env";
import { prisma } from "../db";
import { logger } from "./logger";

const RESEND_API_URL = "https://api.resend.com/emails";
const RESEND_FETCH_TIMEOUT_MS = 10_000;

export type SendEmailInput = {
	to: string;
	subject: string;
	html: string;
	text?: string;
	tags?: { name: string; value: string }[];
};

export type SendEmailResult =
	| { ok: true; id: string }
	| { ok: false; reason: "disabled" | "suppressed" | "transport_error"; detail?: string };

// Check whether an email is on the suppression list. Suppressions come from
// the Resend webhook (hard bounces, complaints) and from manual entries we
// add when an account hits its retry ceiling.
async function isSuppressed(email: string): Promise<boolean> {
	const row = await prisma.emailSuppression.findUnique({
		where: { email: email.toLowerCase() },
		select: { email: true },
	});
	return row !== null;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
	if (!env.EMAIL_ENABLED) {
		logger.info({ to: input.to, subject: input.subject }, "[email] disabled, skipping send");
		return { ok: false, reason: "disabled" };
	}

	if (!env.RESEND_API_KEY) {
		logger.error("[email] EMAIL_ENABLED=true but RESEND_API_KEY missing");
		return { ok: false, reason: "transport_error", detail: "missing api key" };
	}

	if (await isSuppressed(input.to)) {
		logger.warn({ to: input.to }, "[email] recipient suppressed, skipping send");
		return { ok: false, reason: "suppressed" };
	}

	const body = {
		from: env.EMAIL_FROM,
		to: input.to,
		reply_to: env.EMAIL_REPLY_TO,
		subject: input.subject,
		html: input.html,
		text: input.text,
		tags: input.tags,
	};

	// Bound the outbound call. A slow/hung Resend connection would otherwise
	// hold an auth request open indefinitely; the auth route is on the hot
	// path so we cap aggressively. 10s is well past Resend's normal p99.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), RESEND_FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(RESEND_API_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.RESEND_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!res.ok) {
			const text = await res.text();
			logger.error(
				{ status: res.status, body: text, to: input.to },
				"[email] Resend API returned non-2xx",
			);
			return { ok: false, reason: "transport_error", detail: `${res.status}: ${text}` };
		}

		const json = (await res.json()) as { id: string };
		logger.info({ id: json.id, to: input.to, subject: input.subject }, "[email] sent");
		return { ok: true, id: json.id };
	} catch (err) {
		logger.error({ err, to: input.to }, "[email] fetch to Resend failed");
		return {
			ok: false,
			reason: "transport_error",
			detail: err instanceof Error ? err.message : String(err),
		};
	} finally {
		clearTimeout(timer);
	}
}
