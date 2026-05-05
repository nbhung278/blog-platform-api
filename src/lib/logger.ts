import pino from "pino";
import { env } from "./env";

// Single logger instance for the whole backend. Keep the API minimal —
// `logger.info({ ... }, "message")` and `logger.error(err, "message")` cover
// 95% of cases. In development we don't pretty-print to stdout (no extra
// dependency); pipe through `pino-pretty` if needed.
export const logger = pino({
	level: env.NODE_ENV === "production" ? "info" : "debug",
	base: undefined, // omit pid/hostname noise
	timestamp: pino.stdTimeFunctions.isoTime,
	formatters: {
		level: (label) => ({ level: label }),
	},
});
