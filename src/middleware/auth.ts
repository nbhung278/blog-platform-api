import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";

type JWTPayload = {
	sub: string;
	email: string;
	username: string;
	exp: number;
};

export const authMiddleware = createMiddleware<{
	Variables: {
		user: JWTPayload;
	};
}>(async (c, next) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const token = authHeader.slice(7);

	try {
		const payload = (await verify(token, process.env.JWT_SECRET!, "HS256")) as JWTPayload;
		c.set("user", payload);
		await next();
	} catch {
		return c.json({ error: "Invalid token" }, 401);
	}
});
