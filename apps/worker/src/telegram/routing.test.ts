import { describe, expect, it } from "vitest";
import { routeChat, topicOf } from "./routing";

describe("topicOf", () => {
  it("returns the thread of a forum topic message", () => {
    expect(topicOf({ is_topic_message: true, message_thread_id: 42 })).toBe(42);
  });

  it("ignores private chats, the General topic and reply threads outside forums", () => {
    expect(topicOf(undefined)).toBeNull();
    expect(topicOf({})).toBeNull();
    expect(topicOf({ message_thread_id: 7 })).toBeNull();
  });
});

describe("routeChat", () => {
  it("sends chats without a mapped project to the super agent", () => {
    expect(routeChat(null)).toEqual({ kind: "orchestrator" });
    expect(routeChat(undefined)).toEqual({ kind: "orchestrator" });
  });

  it("sends a project topic to the project's manager, inside the project", () => {
    expect(routeChat({ id: "p1", name: "Shop", managerAgentId: "m1" })).toEqual({
      kind: "manager",
      agentId: "m1",
      projectId: "p1",
    });
  });

  it("answers nobody in a project topic without a manager", () => {
    expect(routeChat({ id: "p1", name: "Shop", managerAgentId: null })).toEqual({ kind: "noManager", project: "Shop" });
  });
});
