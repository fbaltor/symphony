import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handleHttpRequest } from "../../src/observability/http-routes.js";
import type { OrchestratorSnapshot } from "../../src/orchestrator/orchestrator.js";
import type { SymphonyConfig } from "../../src/workflow/config.js";

/**
 * Boots a real `node:http` server bound to `handleHttpRequest` and asserts
 * the wire format. Mocks `Orchestrator.snapshot()` and the audit pool so we
 * don't need Postgres or the orchestrator's state machine to run.
 */

interface PortableServer {
  port: number;
  close: () => Promise<void>;
}

function bootServer(handler: (url: string, res: import("node:http").ServerResponse) => void) {
  return new Promise<PortableServer>((resolve) => {
    const server = createServer((req, res) => handler(req.url ?? "", res));
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  const body = (await res.json()) as unknown;
  return { status: res.status, body };
}

const fakeSnapshot: OrchestratorSnapshot = {
  running: [
    {
      identifier: "PROJ-441",
      state: "Plan",
      started_at: "2026-04-29T12:00:00.000Z",
      duration_seconds: 240,
    },
  ],
  retrying: [],
  totals_since_start: {
    input_tokens: 100,
    output_tokens: 200,
    total_tokens: 300,
    cost_usd: 0.5,
    seconds_running: 60,
  },
  config: {
    active_states: ["Plan", "Implement"],
    terminal_states: ["Done"],
    max_concurrent_agents: 3,
    model: "claude-opus-4-7",
  },
};

const fakeConfig = {
  guardrails: {
    dailyCapUsd: 250,
    perIssueCapUsd: 30,
  },
} as unknown as SymphonyConfig;

const fakePool = {
  query: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const servers: PortableServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    if (s) await s.close();
  }
  vi.clearAllMocks();
});

describe("HTTP routes", () => {
  it("/health returns 503 starting before bootstrap completes", async () => {
    const server = await bootServer(
      (url, res) =>
        void handleHttpRequest(url, res, {
          bootstrapReady: false,
          bootstrapError: "DATABASE_URL not set",
          orchestrator: null,
          pool: null,
          config: null,
          instanceId: null,
        }),
    );
    servers.push(server);
    const { status, body } = await fetchJson(`http://127.0.0.1:${server.port}/health`);
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: "starting" });
  });

  it("/health returns 200 ok once bootstrapReady", async () => {
    const server = await bootServer(
      (url, res) =>
        void handleHttpRequest(url, res, {
          bootstrapReady: true,
          bootstrapError: null,
          orchestrator: { snapshot: () => fakeSnapshot },
          pool: fakePool,
          config: fakeConfig,
          instanceId: "symphony-orchestrator-00012-hwz-abc123",
        }),
    );
    servers.push(server);
    const { status, body } = await fetchJson(`http://127.0.0.1:${server.port}/health`);
    expect(status).toBe(200);
    // /health envelope now includes build provenance (version + gitSha).
    expect(body).toMatchObject({ status: "ok" });
  });

  it("/status returns snapshot + instance_id", async () => {
    const server = await bootServer(
      (url, res) =>
        void handleHttpRequest(url, res, {
          bootstrapReady: true,
          bootstrapError: null,
          orchestrator: { snapshot: () => fakeSnapshot },
          pool: fakePool,
          config: fakeConfig,
          instanceId: "symphony-orchestrator-00012-hwz-abc123",
        }),
    );
    servers.push(server);
    const { status, body } = await fetchJson(`http://127.0.0.1:${server.port}/status`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      instance_id: "symphony-orchestrator-00012-hwz-abc123",
      running: [
        {
          identifier: "PROJ-441",
          state: "Plan",
          duration_seconds: 240,
        },
      ],
      totals_since_start: {
        input_tokens: 100,
        output_tokens: 200,
        cost_usd: 0.5,
      },
      config: {
        max_concurrent_agents: 3,
        model: "claude-opus-4-7",
      },
    });
  });

  it("/cost returns spend rollup + caps", async () => {
    const queryStub = vi.fn();
    queryStub
      .mockResolvedValueOnce({ rows: [{ total: 12.34 }] }) // today
      .mockResolvedValueOnce({ rows: [{ total: 87.65 }] }) // month
      .mockResolvedValueOnce({
        rows: [
          {
            identifier: "PROJ-447",
            total_usd: 35,
            runs: 5,
            first_seen: new Date("2026-04-01T00:00:00Z"),
            last_seen: new Date("2026-04-29T00:00:00Z"),
          },
          {
            identifier: "PROJ-446",
            total_usd: 7.5,
            runs: 2,
            first_seen: new Date("2026-04-01T00:00:00Z"),
            last_seen: new Date("2026-04-29T00:00:00Z"),
          },
        ],
      });

    const server = await bootServer(
      (url, res) =>
        void handleHttpRequest(url, res, {
          bootstrapReady: true,
          bootstrapError: null,
          orchestrator: { snapshot: () => fakeSnapshot },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pool: { query: queryStub } as any,
          config: fakeConfig,
          instanceId: "symphony-orchestrator-00012-hwz-abc123",
        }),
    );
    servers.push(server);
    const { status, body } = await fetchJson(`http://127.0.0.1:${server.port}/cost`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      today_usd: 12.34,
      month_usd: 87.65,
      by_issue: [
        { identifier: "PROJ-447", total_usd: 35, runs: 5 },
        { identifier: "PROJ-446", total_usd: 7.5, runs: 2 },
      ],
      caps: {
        daily_cap_usd: 250,
        per_issue_cap_usd: 30,
        daily_remaining_usd: 237.66,
        any_capped_issues: ["PROJ-447"],
      },
    });
  });

  it("/cost returns 503 when bootstrap incomplete (no pool)", async () => {
    const server = await bootServer(
      (url, res) =>
        void handleHttpRequest(url, res, {
          bootstrapReady: false,
          bootstrapError: "DATABASE_URL not set",
          orchestrator: null,
          pool: null,
          config: null,
          instanceId: null,
        }),
    );
    servers.push(server);
    const { status, body } = await fetchJson(`http://127.0.0.1:${server.port}/cost`);
    expect(status).toBe(503);
    expect(body).toMatchObject({ status: "starting" });
  });

  it("unknown path returns 404", async () => {
    const server = await bootServer(
      (url, res) =>
        void handleHttpRequest(url, res, {
          bootstrapReady: true,
          bootstrapError: null,
          orchestrator: { snapshot: () => fakeSnapshot },
          pool: fakePool,
          config: fakeConfig,
          instanceId: "symphony-orchestrator-00012-hwz-abc123",
        }),
    );
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(res.status).toBe(404);
  });
});
