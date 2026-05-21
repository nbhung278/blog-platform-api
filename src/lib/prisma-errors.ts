import { Prisma } from "@prisma/client";

// Narrow check used by route handlers to translate Prisma's P2002 (unique
// constraint violation) into a clean 4xx response. Without this helper the
// pattern lives inline in five places (auth/register, users PATCH, follows
// race, categories create/update, OAuth signup) — duplicated and inconsistent
// in how the error shape is matched.
//
// Accepts unknown rather than Error so callers can pass the value straight
// out of a catch block without an extra `instanceof Error` guard.
//
// Prisma 7 may surface the code on the top-level error, on a wrapped `cause`,
// or only embedded in `message` (when the error has been re-thrown by middleware).
// Probe all three so a refactor of the call chain doesn't silently downgrade
// a 409 path back into a 500.
export function isUniqueViolation(err: unknown): boolean {
	if (err instanceof Prisma.PrismaClientKnownRequestError) {
		return err.code === "P2002";
	}
	if (err && typeof err === "object") {
		const e = err as { code?: string; cause?: { code?: string }; message?: string };
		if (e.code === "P2002" || e.cause?.code === "P2002") return true;
		if (typeof e.message === "string" && e.message.includes("P2002")) return true;
	}
	return false;
}
