export interface Actor {
  id: string;
  telegramId: string;
  role: "BUYER" | "STAFF" | "OWNER";
}
declare module "fastify" {
  interface FastifyRequest {
    actor: Actor;
    sessionId?: string;
    authAt?: Date;
  }
}
