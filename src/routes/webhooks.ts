import { Hono } from "hono";
import { prisma } from "../db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { verifyResendWebhook } from "../lib/svix-verify";

export const webhooksRoutes = new Hono();

type ResendEvent = {
	type: string;
	created_at: string;
	data: {
		email_id?: string;
		to?: string[] | string;
		from?: string;
		subject?: string;
		// bounce-only fields
		bounce_type?: "hard" | "soft";
		// complaint-only fields
		[k: string]: unknown;
	};
};

function recipientsOf(event: ResendEvent): string[] {
	const to = event.data.to;
	if (!to) return [];
	const arr = Array.isArray(to) ? to : [to];
	return arr.map((e) => e.toLowerCase());
}

webhooksRoutes.post("/resend", async (c) => {
	if (!env.RESEND_WEBHOOK_SECRET) {
		logger.error("[webhook] RESEND_WEBHOOK_SECRET not configured");
		return c.json({ error: "Webhook not configured" }, 503);
	}

	const rawBody = await c.req.text();
	const verifyResult = verifyResendWebhook({
		svixId: c.req.header("svix-id"),
		svixTimestamp: c.req.header("svix-timestamp"),
		svixSignature: c.req.header("svix-signature"),
		rawBody,
		secret: env.RESEND_WEBHOOK_SECRET,
	});

	if (!verifyResult.ok) {
		logger.warn({ reason: verifyResult.reason }, "[webhook] Resend signature verify failed");
		return c.json({ error: "Invalid signature" }, 401);
	}

	let event: ResendEvent;
	try {
		event = JSON.parse(rawBody) as ResendEvent;
	} catch {
		return c.json({ error: "Malformed body" }, 400);
	}

	logger.info(
		{ type: event.type, emailId: event.data.email_id, to: event.data.to },
		"[webhook] Resend event",
	);

	switch (event.type) {
		case "email.bounced": {
			// Only hard bounces go in the suppression list. Soft bounces (mailbox
			// full, temporary issues) might recover on retry, so we don't punish
			// the recipient permanently.
			if (event.data.bounce_type === "hard") {
				for (const email of recipientsOf(event)) {
					await prisma.emailSuppression.upsert({
						where: { email },
						create: { email, reason: "bounced", bounceType: "hard" },
						update: { reason: "bounced", bounceType: "hard" },
					});
				}
			}
			break;
		}
		case "email.complained": {
			// User marked the email as spam — biggest deliverability hit. Suppress
			// immediately, no exceptions.
			for (const email of recipientsOf(event)) {
				await prisma.emailSuppression.upsert({
					where: { email },
					create: { email, reason: "complained" },
					update: { reason: "complained" },
				});
			}
			break;
		}
		case "email.delivered":
		case "email.delivery_delayed":
			// Logged at info level above; no DB action needed today. Future: track
			// per-email delivery status if we ever ship retry/observability tools.
			break;
		default:
			logger.debug({ type: event.type }, "[webhook] unhandled event type");
	}

	return c.json({ ok: true });
});
