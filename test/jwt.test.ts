import { describe, it, expect } from "vitest";
import { decodeJwtPayload, resolveIdentity } from "../src/jwt.js";

function b64(o: unknown) { return Buffer.from(JSON.stringify(o)).toString("base64url"); }
function tok(p: unknown) { return `h.${b64(p)}.s`; }

describe("jwt", () => {
  it("畸形 token 返回 null", () => { expect(decodeJwtPayload("bad")).toBeNull(); });
  it("tenant 8变体", () => {
    expect(resolveIdentity({ iss: "https://x/realms/sso-abc123" } as any).tenantId).toBe("abc123");
    expect(resolveIdentity({ tenant_id: "t1" } as any).tenantId).toBe("t1");
  });
  it("iss 中段 sso- 不误匹配（$ 锚）", () => {
    expect(resolveIdentity({ iss: "https://x/realms/sso-abc/extra" } as any).tenantId).toBe("");
  });
  it("enterprise group-admin 遍历", () => {
    expect(resolveIdentity({ realm_access: { roles: ["group-admin:ent-1"] } } as any).enterpriseId).toBe("ent-1");
  });
  it("cfg 短路优先于 JWT", () => {
    expect(resolveIdentity({ tenant_id: "jwt" } as any, { tenantId: "cfg" } as any).tenantId).toBe("cfg");
  });
});