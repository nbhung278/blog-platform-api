import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sign } from "hono/jwt";
import { hash, compare } from "bcrypt";
import { prisma } from "../db";
import { authMiddleware } from "../middleware/auth";

export const authRoutes = new Hono();

const registerSchema = z.object({
	email: z.string().email(),
	password: z.string().min(8),
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

authRoutes.post("/register", zValidator("json", registerSchema), async (c) => {
	const { email, password, name, username } = c.req.valid("json");

	const existing = await prisma.user.findUnique({ where: { email } });
	if (existing) {
		return c.json({ error: "Email already registered" }, 400);
	}

	const passwordHash = await hash(password, 10);

	const user = await prisma.user.create({
		data: { email, passwordHash, name, username },
		select: { id: true, email: true, username: true, name: true },
	});

	const token = await sign(
		{
			sub: user.id,
			email: user.email,
			username: user.username,
			exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
		},
		process.env.JWT_SECRET!,
	);

	return c.json({ token, user }, 201);
});

authRoutes.post("/login", zValidator("json", loginSchema), async (c) => {
	const { email, password } = c.req.valid("json");

	const user = await prisma.user.findUnique({ where: { email } });
	if (!user) {
		return c.json({ error: "Invalid credentials" }, 401);
	}

	const valid = await compare(password, user.passwordHash);
	if (!valid) {
		return c.json({ error: "Invalid credentials" }, 401);
	}

	const token = await sign(
		{
			sub: user.id,
			email: user.email,
			username: user.username,
			exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
		},
		process.env.JWT_SECRET!,
	);

	return c.json({
		token,
		user: { id: user.id, email: user.email, name: user.name, username: user.username },
	});
});

authRoutes.get("/me", authMiddleware, async (c) => {
	const jwtPayload = c.get("user");

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
		},
	});

	if (!user) {
		return c.json({ error: "User not found" }, 404);
	}

	return c.json(user);
});
