import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetGithubAuthCache,
  buildAppJwt,
  normalizePrivateKey,
  readCredsFromEnv,
  resolveGitHubToken,
} from "../../src/lib/github-auth.js";

/**
 * Sample RSA-2048 PEM generated only for tests. NOT a real key — never gets
 * sent anywhere. Generated via `openssl genrsa 2048` and committed for the
 * vitest suite so JWT signing has something to sign with offline.
 */
const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDBFpBNs9dQGpj9
6c8TtX1Cn5HEDApaKVdkLnaPBVFqf3VZ4zfA8qsWBJSyVJ1bsYWlJmcnxfgF+yfN
+z3BuhJN5nC3Ey2+yh7n/2W4/hcNvDg6tAohbpQOY7thWIGmRT4Yz1eQ8QSv6KIv
tF3gkAY1EI6xTTKdfDuRZlu+9jaJJhXxAJrQZPGCnWIozpbm3DD+m8ORA3TIO+RJ
qmS9/pRfDXNvHQsjHFftzFEJ0KqcvBb95Xz5RWiNXUx12ttMI9sYj5MVL/Bh2I2K
zeRwNxxQSn0hcRRy0iL8w6WmkLOAFpSPTGEU6qWpScfNI82Q6Pk5+M8/6NHt/MVA
lWN8qvERAgMBAAECggEALoIcmvgiPI+Dzfpv7aEqDmd3AMUd/yrBcKSbE9TsPUB1
2gLp7VwgRy6kPF5h+8AiQtDUwzqXJUNFqtczdyoGm5U5sPDJTw6B9TC/OXNHaqW/
8a9N18CvpWE4QRFXR45tt7RRf9PJYYyPSALXgcjoChBmhI6jkJoNxdMrwhxqW4Qj
F7B+P5+j1XIxR/qVYuvOwTlwRphImBTOKOA8I6NN4CKn4BnLW2CD+E4/aozNIRWO
CtKQNSJW/qgEEt6pp+JFdgB2vQBJHUk73RgCjZIRkbz/T4VnNmlSPjUzUHFiu/DM
BsuyiDtPJ+IQrWOjW4QqXR9o4Nl9PHM5iqdC0t9V7QKBgQDtj1z7yu+tWWf8FA9z
RI/Qp/qzr07Bqmm6N9AlMdRnGsczj9pDRcKi2YDNwf2rDw3v7gHC5e5j8QiHv5T8
n2kwXi4yNm3ufSlhwiu1TjkRpWdU+tkMjfCgKKoWdHXSNNNTC/N9jfo+zMaGz0VF
kyGGfQNi0ay1MnA4JjcXDFM7jQKBgQDQQVN0kUjZPZ6PXC4RoLnGpwBMRdzLh0Xj
XCmuJ+r9gcaTnRBRnotGgDe1PXyzS8hnLM1fS/TC8xZLs7n+sPtBcr04hrmRfDk5
Mx00vU0HjP0kKi1ifzxItbeVTk/lwjzJffVu2pBXIc0CN3hgEsqSiEs5Vjjz2tMD
S2D6KBC/lQKBgQCYQHyHb43cQuZXZ4ASvWVXLm/PcYJxMfLbRxCXEbBYwAsmWp9F
EH2TtdzxGtktHYOfuOSrFVWbmxEKfgBJ/8tdpPfg0TawV9UYJrr6N8CTmvnDhRWv
P4FIHsNYj3D5Z8/iMTwzPm88X/yrJfqGXPwXRwkkjMBaUgLFoBuFUYPJfQKBgGRt
XRY/y0xqfIiNYPJdfKiIggthIwrPMwa/sZLP/ImYrCNSbMTphTm05khVwy0XY3dN
0AgnXiObMZ4iNNiDNbVNnYXCi1TMx2kJ+nTQKzRTfXXz0L/xBnoEN7uM3hZpxxoo
cZ0fuC/Hv70rWxZmADRxd+ekSWq03Yv4MXoVPC55AoGAZEoMYR2WWNDX3VGLHL9r
5N5Gs3/u4cF3fCAYYfbvgmDP7DfZjU7d3RcfS1hkVXsQ5lQhMoUtBeQc4w5SS2lP
EvdvAnjhz7s6Vj4LBdmRG3KIoJtxQENrjAk3GdFp0Stbv8EdbVe/lGAR6fPdt7uM
S7ToTxQwfX2fL7pEJDNhbcU=
-----END PRIVATE KEY-----`;

describe("normalizePrivateKey", () => {
  it("converts literal '\\n' sequences to real newlines", () => {
    const collapsed = TEST_PRIVATE_KEY_PEM.replace(/\n/g, "\\n");
    expect(collapsed).toContain("\\n");
    const out = normalizePrivateKey(collapsed);
    expect(out).not.toContain("\\n");
    expect(out.split("\n").length).toBeGreaterThan(5);
  });

  it("leaves already-normalized PEMs untouched", () => {
    expect(normalizePrivateKey(TEST_PRIVATE_KEY_PEM)).toBe(TEST_PRIVATE_KEY_PEM);
  });
});

describe("readCredsFromEnv", () => {
  it("returns null when any of the three env vars is missing", () => {
    expect(readCredsFromEnv({})).toBeNull();
    expect(readCredsFromEnv({ GITHUB_APP_ID: "1" })).toBeNull();
    expect(readCredsFromEnv({ GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2" })).toBeNull();
  });

  it("returns null when any value is empty / whitespace", () => {
    expect(
      readCredsFromEnv({
        GITHUB_APP_ID: "",
        GITHUB_APP_INSTALLATION_ID: "2",
        GITHUB_APP_PRIVATE_KEY: "x",
      }),
    ).toBeNull();
    expect(
      readCredsFromEnv({
        GITHUB_APP_ID: "  ",
        GITHUB_APP_INSTALLATION_ID: "2",
        GITHUB_APP_PRIVATE_KEY: "x",
      }),
    ).toBeNull();
  });

  it("returns parsed creds when all three are present", () => {
    const creds = readCredsFromEnv({
      GITHUB_APP_ID: "1234",
      GITHUB_APP_INSTALLATION_ID: "5678",
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    });
    expect(creds).not.toBeNull();
    expect(creds?.appId).toBe("1234");
    expect(creds?.installationId).toBe("5678");
    expect(creds?.privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
  });
});

describe("buildAppJwt", () => {
  it("emits a 3-segment compact JWT", () => {
    const jwt = buildAppJwt("1234", TEST_PRIVATE_KEY_PEM);
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("encodes the appId in the JWT iss claim", () => {
    const jwt = buildAppJwt("9999", TEST_PRIVATE_KEY_PEM);
    const [, payloadB64] = jwt.split(".");
    const payload = JSON.parse(
      Buffer.from(payloadB64!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    expect(payload.iss).toBe("9999");
    expect(payload.exp - payload.iat).toBeGreaterThan(500);
  });
});

describe("getInstallationToken (cache)", () => {
  beforeEach(() => {
    _resetGithubAuthCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when env is missing", async () => {
    const { getInstallationToken } = await import("../../src/lib/github-auth.js");
    expect(await getInstallationToken({})).toBeNull();
  });
});

describe("resolveGitHubToken (App token, else GITHUB_TOKEN PAT)", () => {
  beforeEach(() => {
    _resetGithubAuthCache();
  });

  it("falls back to the GITHUB_TOKEN PAT when no GH App is configured", async () => {
    // No GH App env vars → getInstallationToken returns null (no network) →
    // resolveGitHubToken returns the PAT.
    expect(await resolveGitHubToken({ GITHUB_TOKEN: "ghp_pat_value" })).toBe("ghp_pat_value");
  });

  it("trims surrounding whitespace on the PAT", async () => {
    expect(await resolveGitHubToken({ GITHUB_TOKEN: "  gho_oauth_value\n" })).toBe("gho_oauth_value");
  });

  it("returns null when neither a GH App nor a PAT is available", async () => {
    expect(await resolveGitHubToken({})).toBeNull();
    expect(await resolveGitHubToken({ GITHUB_TOKEN: "   " })).toBeNull();
  });
});
