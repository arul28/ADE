/**
 * The account's model picker favorites (`/account/model-favorites`) against a
 * real SQLite engine with every migration applied: one list per account that
 * every device changes with `{add, remove}`. The contract a device depends on
 * is that its change lands on the list the account holds, even when another
 * device wrote in between, and never on another account's list (not even a
 * change queued under one account and sent after another signed in).
 */
import { expect, it } from "vitest";
import { handleAccountModelFavoritesRequest } from "../src/accountModelFavorites/routes";
import { makeEnv, mintFreshAuthToken, request } from "./helpers";
import { sqliteD1 } from "./sqliteD1";

it("lands each device's change on the account's own list, even when another device wrote between its read and its write", async () => {
  const sql = sqliteD1();
  // Another device's star lands right after the first read of the list, as a
  // phone tapping at the same moment as the desktop would.
  let raced = false;
  const DB = new Proxy(sql.DB as object, {
    get(target, prop) {
      if (prop !== "prepare") return Reflect.get(target, prop);
      return (query: string) => {
        const statement = (target as D1Database).prepare(query);
        if (raced || !query.includes("select favorites, revision")) return statement;
        return {
          bind: (...args: unknown[]) => ({
            first: async () => {
              const row = await statement.bind(...args).first();
              raced = true;
              sql.exec("insert into account_model_favorites values ('user_a', '[\"phone-star\"]', 1, 0)");
              return row;
            },
          }),
        };
      };
    },
  }) as D1Database;
  const env = { ...makeEnv(), DB } as never;
  const call = async (token: string, method: string, body?: unknown) => {
    const response = await handleAccountModelFavoritesRequest(request(method, "/account/model-favorites", token, body), env);
    return { status: response.status, body: await response.json() as { favorites?: string[]; revision?: number } };
  };
  const userA = await mintFreshAuthToken("user_a");
  const userB = await mintFreshAuthToken("user_b");

  const desktop = await call(userA, "PUT", { add: ["desktop-star", "old-star"] });
  expect(raced, "setup: the other device wrote between the read and the write").toBe(true);
  expect(desktop).toEqual({ status: 200, body: { favorites: ["phone-star", "desktop-star", "old-star"], revision: 2 } });

  const removed = await call(userA, "PUT", { remove: ["old-star"] });
  expect(removed.body).toEqual({ favorites: ["phone-star", "desktop-star"], revision: 3 });

  // Another account sees none of it, and its change does not touch the first list.
  expect((await call(userB, "GET")).body).toEqual({ favorites: [], revision: 0 });
  // A change queued under user_a and sent after user_b signed in is refused.
  expect((await call(userB, "PUT", { add: ["queued-under-a"], account: "user_a" })).status).toBe(403);
  expect((await call(userB, "PUT", { add: ["b-star"] })).body).toEqual({ favorites: ["b-star"], revision: 1 });
  expect((await call(userA, "GET")).body).toEqual({ favorites: ["phone-star", "desktop-star"], revision: 3 });
});
