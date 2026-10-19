import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../apps/api/src/app.js";
import { digest, token } from "../apps/api/src/auth.js";
import { migrate, type DB } from "../apps/api/src/db.js";
import { isolatedTestDB } from "./isolated-db.js";

const origin = "http://localhost:5173";
let db: DB;
const accounts: { id: string; cookie: string; csrf: string }[] = [];

async function session(userId: string, expired = false) {
  const sid = token();
  const csrf = token();
  await db.query(
    `INSERT INTO sessions VALUES($1,$2,$3,now()+interval '${expired ? "-1 second" : "8 hours"}')`,
    [digest(sid), userId, csrf],
  );
  return { id: userId, cookie: `sid=${sid}`, csrf };
}

async function application(database = db) {
  return createApp(database, {
    origin,
    secure: false,
    executionApproved: false,
    model: "",
    image: "",
  });
}

beforeAll(async () => {
  db = await isolatedTestDB();
  await migrate(db);
  for (let index = 0; index < 50; index++) {
    const id = randomUUID();
    await db.query("INSERT INTO users VALUES($1,$2,'quota',$3,'unused')", [
      id,
      `${id}@test.local`,
      index === 0 ? "teacher" : "student",
    ]);
    accounts.push(await session(id));
  }
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("verified-account request quotas", () => {
  it("keeps three classroom writes per account independent on one shared IP", async () => {
    const app = await application();
    try {
      for (let round = 0; round < 3; round++) {
        const responses = await Promise.all(
          accounts.map((account) =>
            app.inject({
              method: "POST",
              url: "/api/v1/classes",
              headers: {
                cookie: account.cookie,
                origin,
                "x-csrf-token": account.csrf,
              },
              payload: {},
              remoteAddress: "127.0.0.1",
            }),
          ),
        );
        for (let index = 0; index < responses.length; index++) {
          expect(responses[index].statusCode).toBe(index === 0 ? 400 : 403);
          expect(responses[index].headers["x-ratelimit-remaining"]).toBe(
            String(99 - round),
          );
        }
      }
    } finally {
      await app.close();
    }
  });
  it("lets 50 verified accounts share an IP without pooling their read allowance", async () => {
    const app = await application();
    try {
      const observed: { status: number; remaining: unknown; round: number }[] =
        [];
      for (let round = 0; round < 6; round++) {
        const responses = await Promise.all(
          accounts.map((account) =>
            app.inject({
              url: "/api/v1/session",
              headers: { cookie: account.cookie },
              remoteAddress: "127.0.0.1",
            }),
          ),
        );
        for (const response of responses) {
          observed.push({
            status: response.statusCode,
            remaining: response.headers["x-ratelimit-remaining"],
            round,
          });
        }
      }
      expect(observed).toHaveLength(300);
      expect(
        observed.filter((response) => response.status === 429),
      ).toHaveLength(0);
      for (const response of observed) {
        expect(response.status).toBe(200);
        expect(response.remaining).toBe(String(239 - response.round));
      }
    } finally {
      await app.close();
    }
  });

  it("shares the 240-read account ceiling across sessions, routes and IPs", async () => {
    const app = await application();
    const otherSession = await session(accounts[0].id);
    try {
      for (let index = 0; index < 240; index++) {
        const actor = index % 2 ? accounts[0] : otherSession;
        const response = await app.inject({
          url: index % 3 ? "/api/v1/session" : "/api/v1/classes",
          headers: { cookie: actor.cookie },
          remoteAddress: index % 2 ? "127.0.0.1" : "127.0.0.2",
        });
        expect(response.statusCode).toBe(200);
      }
      const limited = await app.inject({
        url: "/api/v1/session",
        headers: { cookie: otherSession.cookie },
        remoteAddress: "127.0.0.3",
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["x-ratelimit-limit"]).toBe("240");
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(
        (
          await app.inject({
            url: "/api/v1/session",
            headers: { cookie: accounts[1].cookie },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("keeps public health reads IP-scoped despite cookies or claimed identities", async () => {
    const app = await application();
    try {
      for (let index = 0; index < 240; index++) {
        const response = await app.inject({
          url: "/api/v1/health",
          headers: {
            cookie: index % 2 ? accounts[0].cookie : `sid=${token()}`,
            "x-user-id": randomUUID(),
          },
        });
        expect(response.statusCode).toBe(200);
      }
      expect((await app.inject("/api/v1/health")).statusCode).toBe(429);
      expect(
        (
          await app.inject({
            url: "/api/v1/session",
            headers: { cookie: accounts[0].cookie },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects absent, forged, expired and revoked sessions before account reads", async () => {
    const app = await application();
    const expired = await session(accounts[0].id, true);
    const revoked = await session(accounts[0].id);
    await db.query("DELETE FROM sessions WHERE id=$1", [
      digest(revoked.cookie.slice(4)),
    ]);
    try {
      const cookies = [
        undefined,
        `sid=${token()}`,
        expired.cookie,
        revoked.cookie,
      ];
      for (let index = 0; index < 244; index++) {
        const cookie = cookies[index % cookies.length];
        const response = await app.inject({
          url: "/api/v1/session",
          headers: {
            ...(cookie ? { cookie } : {}),
            "x-user-id": accounts[0].id,
          },
        });
        expect(response.statusCode).toBe(401);
      }
      const valid = await app.inject({
        url: "/api/v1/session",
        headers: { cookie: accounts[0].cookie },
      });
      expect(valid.statusCode).toBe(200);
      expect(valid.headers["x-ratelimit-remaining"]).toBe("239");
    } finally {
      await app.close();
    }
  });

  it("uses the existing verified session without a second database lookup", async () => {
    const query = vi.fn((sql: string, params?: any[]) => db.query(sql, params));
    const app = await application({ ...db, query });
    try {
      await app.ready();
      query.mockClear();
      const response = await app.inject({
        url: "/api/v1/session",
        headers: { cookie: accounts[0].cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toContain("JOIN users");
      expect(query.mock.calls[0][1]).toEqual([
        digest(accounts[0].cookie.slice(4)),
      ]);
    } finally {
      await app.close();
    }
  });

  it("shares the 100-write account ceiling across sessions, routes and IPs", async () => {
    const app = await application();
    const otherSession = await session(accounts[0].id);
    const missingClass = randomUUID();
    try {
      for (let index = 0; index < 101; index++) {
        const actor = index % 2 ? accounts[0] : otherSession;
        const response = await app.inject({
          method: "POST",
          url:
            index % 2
              ? `/api/v1/classes/${missingClass}/students`
              : "/api/v1/classes",
          headers: {
            cookie: actor.cookie,
            origin,
            "x-csrf-token": actor.csrf,
          },
          payload: {},
          remoteAddress: index % 2 ? "127.0.0.1" : "127.0.0.2",
        });
        expect(response.statusCode).toBe(
          index === 100 ? 429 : index % 2 ? 404 : 400,
        );
        if (index === 100) {
          expect(response.headers["x-ratelimit-limit"]).toBe("100");
          expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
        }
      }
      const other = await app.inject({
        method: "POST",
        url: "/api/v1/classes",
        headers: {
          cookie: accounts[1].cookie,
          origin,
          "x-csrf-token": accounts[1].csrf,
        },
        payload: {},
      });
      expect(other.statusCode).toBe(403);
      expect(other.headers["x-ratelimit-remaining"]).toBe("99");
      expect(
        (
          await app.inject({
            url: "/api/v1/session",
            headers: { cookie: accounts[0].cookie },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("does not trust claimed identities or invalid CSRF for account write allowance", async () => {
    const app = await application();
    const expired = await session(accounts[0].id, true);
    const revoked = await session(accounts[0].id);
    await db.query("DELETE FROM sessions WHERE id=$1", [
      digest(revoked.cookie.slice(4)),
    ]);
    try {
      const cookies = [
        undefined,
        `sid=${token()}`,
        expired.cookie,
        revoked.cookie,
      ];
      for (let index = 0; index < 104; index++) {
        const cookie = cookies[index % cookies.length];
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/classes",
          headers: {
            ...(cookie ? { cookie } : {}),
            origin,
            "x-user-id": accounts[0].id,
            "x-csrf-token": accounts[0].csrf,
          },
          payload: {},
        });
        expect(response.statusCode).toBe(401);
      }
      const badCsrf = await app.inject({
        method: "POST",
        url: "/api/v1/classes",
        headers: {
          cookie: accounts[0].cookie,
          origin,
          "x-csrf-token": "wrong",
        },
        payload: {},
      });
      expect(badCsrf.statusCode).toBe(403);
      const valid = await app.inject({
        method: "POST",
        url: "/api/v1/classes",
        headers: {
          cookie: accounts[0].cookie,
          origin,
          "x-csrf-token": accounts[0].csrf,
        },
        payload: {},
      });
      expect(valid.statusCode).toBe(400);
      expect(valid.headers["x-ratelimit-remaining"]).toBe("99");
    } finally {
      await app.close();
    }
  });

  it("retains the 10-login IP ceiling despite rotating cookies and identity headers", async () => {
    const app = await application();
    try {
      for (let index = 0; index < 11; index++) {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/session/login",
          headers: {
            origin,
            cookie: accounts[index].cookie,
            "x-user-id": accounts[index].id,
          },
          payload: {},
        });
        expect(response.statusCode).toBe(index === 10 ? 429 : 400);
      }
    } finally {
      await app.close();
    }
  });
});
