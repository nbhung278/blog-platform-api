import type { Context } from "hono";

const PRIVATE_NO_STORE = "private, no-store, max-age=0, must-revalidate";

export function setPrivateNoStore(c: Context): void {
	c.header("Cache-Control", PRIVATE_NO_STORE);
	c.header("Vary", "Cookie, Authorization");
}
