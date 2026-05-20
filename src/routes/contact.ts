import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ipRateLimit } from "../middleware/rate-limit";
import { sendEmail } from "../lib/email";
import { buildContactEmail } from "../lib/email-templates";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

export const contactRoutes = new Hono();

const contactSchema = z.object({
	name: z.string().trim().min(1, "Name is required").max(120),
	email: z.string().trim().toLowerCase().email("Valid email is required").max(254),
	message: z.string().trim().min(10, "Message must be at least 10 characters").max(5000),
	// Honeypot. Accept any string here so the schema doesn't 400 on filled-in
	// values — the handler treats anything non-empty as bot activity and
	// silently returns success.
	website: z.string().max(500).optional(),
});

// Inbox that receives contact-form submissions. We reuse EMAIL_REPLY_TO (the
// support address) so a single env covers both "where do replies go" and
// "where do new contact messages land".
const CONTACT_INBOX = env.EMAIL_REPLY_TO.includes("<")
	? (env.EMAIL_REPLY_TO.match(/<([^>]+)>/)?.[1] ?? env.EMAIL_REPLY_TO)
	: env.EMAIL_REPLY_TO;

contactRoutes.post(
	"/",
	// 5/hour per IP — enough for someone refining a message, low enough to
	// blunt any scripted abuse that gets past the honeypot.
	ipRateLimit({ keyPrefix: "contact", limit: 5, windowSeconds: 60 * 60 }),
	zValidator("json", contactSchema),
	async (c) => {
		const { name, email, message, website } = c.req.valid("json");

		// Honeypot tripped — pretend success so the bot moves on without retrying
		// and without learning that the field is the trap.
		if (website && website.length > 0) {
			logger.warn({ email, name }, "[contact] honeypot tripped, dropping");
			return c.json({ ok: true });
		}

		const tpl = buildContactEmail({ name, fromEmail: email, message });
		const result = await sendEmail({
			to: CONTACT_INBOX,
			subject: tpl.subject,
			html: tpl.html,
			text: tpl.text,
			tags: [{ name: "purpose", value: "contact" }],
		});

		if (!result.ok && result.reason === "transport_error") {
			logger.error({ detail: result.detail, email }, "[contact] failed to deliver");
			return c.json(
				{ error: "Could not send your message right now. Please try again later." },
				502,
			);
		}

		// `disabled` and `suppressed` both look like success to the user; the
		// admin inbox is on the suppression list is a misconfiguration we want
		// to fix server-side, not surface to the visitor.
		return c.json({ ok: true });
	},
);
