import { describe, expect, it } from "vitest";
import type { Agent, RuntimeDevice } from "@multica/core/types";
import {
  agentFormCreateRequest,
  agentFormUpdateRequest,
  canSubmitAgentForm,
  initialAgentFormValues,
} from "./agent-form";

const runtimes = [
  { id: "offline", status: "offline" },
  { id: "online", status: "online" },
] as RuntimeDevice[];

const values = {
  name: "  iOS 开发  ",
  description: "  负责移动端  ",
  instructions: "  先测试再交付  ",
  runtimeId: " online ",
  model: " kimi-code/k3.1-pro ",
  visibility: "workspace" as const,
};

describe("agent form", () => {
  it("prefills an existing agent without dropping its configuration", () => {
    const agent = {
      name: "Existing",
      description: "Description",
      instructions: "Instructions",
      runtime_id: "runtime-existing",
      model: "model-existing",
      visibility: "private",
    } as Agent;

    expect(initialAgentFormValues(agent, runtimes)).toEqual({
      name: "Existing",
      description: "Description",
      instructions: "Instructions",
      runtimeId: "runtime-existing",
      model: "model-existing",
      visibility: "private",
    });
  });

  it("selects an online runtime for a new agent", () => {
    expect(initialAgentFormValues(undefined, runtimes).runtimeId).toBe("online");
    expect(initialAgentFormValues(undefined, runtimes).visibility).toBe("workspace");
  });

  it("maps a trimmed create request", () => {
    expect(agentFormCreateRequest(values)).toEqual({
      name: "iOS 开发",
      description: "负责移动端",
      instructions: "先测试再交付",
      runtime_id: "online",
      model: "kimi-code/k3.1-pro",
      visibility: "workspace",
    });
  });

  it("maps a trimmed update request", () => {
    expect(agentFormUpdateRequest(values)).toEqual({
      name: "iOS 开发",
      description: "负责移动端",
      instructions: "先测试再交付",
      runtime_id: "online",
      model: "kimi-code/k3.1-pro",
      visibility: "workspace",
    });
  });

  it("requires a name and runtime", () => {
    expect(canSubmitAgentForm(values)).toBe(true);
    expect(canSubmitAgentForm({ ...values, name: " " })).toBe(false);
    expect(canSubmitAgentForm({ ...values, runtimeId: " " })).toBe(false);
  });
});
