import type { ZodType } from "zod";
import { Errors } from "./errors.ts";

export function parseBody<T>(schema: ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path?.join(".") || "(body)";
    throw Errors.validation(`${path}: ${first?.message ?? "valor inválido"}`);
  }
  return result.data;
}
