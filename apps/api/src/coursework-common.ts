import type { FastifyRequest } from "fastify";
export type CourseActor = { id: string; role: string };
export type CourseRow = Record<string, any>;
export class CourseworkError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export function courseFail(
  code: string,
  message: string,
  statusCode = 400,
): never {
  throw new CourseworkError(code, message, statusCode);
}
export const courseActor = (req: FastifyRequest): CourseActor =>
  (req as FastifyRequest & { user: CourseActor }).user;
export const courseHash = async (value: unknown) => {
  const { canonicalJson, sha256 } = await import(
    "../../../packages/contracts/src/v2/index.js"
  );
  return sha256(canonicalJson(value));
};
