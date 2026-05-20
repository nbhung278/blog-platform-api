const BRAND = "Strix Blog";
const SUPPORT_EMAIL = "support@strix-blog.uk";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function shell(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;padding:32px;">
<tr><td>
<h1 style="margin:0 0 24px;font-size:20px;color:#1c1917;">${escapeHtml(BRAND)}</h1>
${body}
<hr style="border:none;border-top:1px solid #e7e5e4;margin:32px 0 16px;">
<p style="margin:0;font-size:12px;color:#78716c;line-height:1.6;">
If you didn't request this, you can safely ignore this email. Need help? Reply to this email or contact ${escapeHtml(SUPPORT_EMAIL)}.
</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export type OtpPurpose = "signup" | "login" | "forgot";

const TITLES: Record<OtpPurpose, string> = {
	signup: "Verify your email",
	login: "Confirm your sign in",
	forgot: "Reset your password",
};

const HEADINGS: Record<OtpPurpose, string> = {
	signup: "Welcome — let's verify your email",
	login: "New sign-in detected",
	forgot: "Reset your password",
};

const INTROS: Record<OtpPurpose, string> = {
	signup: "You're almost done creating your account. Enter the code below to finish signing up.",
	login:
		"We noticed you're signing in from a device we don't recognise. Enter the code below to continue.",
	forgot: "Enter the code below to set a new password.",
};

export function buildContactEmail(input: { name: string; fromEmail: string; message: string }): {
	subject: string;
	html: string;
	text: string;
} {
	// Strip CR/LF from anything that lands in the Subject header — a stray
	// newline in a user-supplied field could otherwise inject extra headers.
	const safeName = input.name.replace(/[\r\n]+/g, " ").trim();
	const safeFromEmail = input.fromEmail.replace(/[\r\n]+/g, " ").trim();
	const subject = `[Contact] ${safeName} (${safeFromEmail})`;
	const body = `
<p style="margin:0 0 16px;font-size:16px;color:#1c1917;">New contact form submission</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;">
<tr><td style="padding:6px 0;font-size:13px;color:#78716c;width:80px;">From</td><td style="padding:6px 0;font-size:14px;color:#1c1917;">${escapeHtml(safeName)} &lt;${escapeHtml(safeFromEmail)}&gt;</td></tr>
</table>
<div style="margin:0 0 8px;padding:16px;background:#fafaf9;border:1px solid #e7e5e4;border-radius:12px;font-size:14px;color:#1c1917;line-height:1.7;white-space:pre-wrap;">${escapeHtml(input.message)}</div>
<p style="margin:16px 0 0;font-size:12px;color:#78716c;">To reply, write to ${escapeHtml(safeFromEmail)} directly — replying to this email reaches the support inbox.</p>`;
	const text = `New contact form submission\n\nFrom: ${safeName} <${safeFromEmail}>\n\n${input.message}\n\n--\nTo reply, write to ${safeFromEmail} directly.`;
	return { subject, html: shell("Contact form", body), text };
}

export function buildOtpEmail(
	purpose: OtpPurpose,
	code: string,
): { subject: string; html: string; text: string } {
	const subject = `${TITLES[purpose]} — code ${code}`;
	const body = `
<p style="margin:0 0 16px;font-size:16px;color:#1c1917;">${escapeHtml(HEADINGS[purpose])}</p>
<p style="margin:0 0 24px;font-size:14px;color:#44403c;line-height:1.6;">${escapeHtml(INTROS[purpose])}</p>
<div style="margin:0 0 24px;padding:20px;background:#fafaf9;border:1px solid #e7e5e4;border-radius:12px;text-align:center;">
<div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:32px;letter-spacing:8px;color:#1c1917;font-weight:600;">${escapeHtml(code)}</div>
</div>
<p style="margin:0;font-size:13px;color:#78716c;line-height:1.6;">This code expires in 10 minutes.</p>`;
	const text = `${HEADINGS[purpose]}\n\n${INTROS[purpose]}\n\nYour code: ${code}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, you can safely ignore this email.`;
	return { subject, html: shell(TITLES[purpose], body), text };
}
