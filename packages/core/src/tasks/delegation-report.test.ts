import { describe, expect, it } from "vitest";
import {
  type DelegationReportMetadata,
  isWithheldReport,
  ownTaskWaitsForReport,
  reportedProjects,
} from "./delegation-report";

const report = (tasks: DelegationReportMetadata["tasks"], withheld?: true): DelegationReportMetadata => ({
  kind: "delegation-report",
  tasks,
  ...(withheld && { withheld }),
});
const task = (id: string, projectId?: string | null) => ({
  id,
  title: id,
  agent: null,
  status: "review" as const,
  ...(projectId !== undefined && { projectId }),
});

describe("reportedProjects", () => {
  it("collects the projects of the reports given to the agent, each once", () => {
    const metadata = [
      report([task("t1", "p1"), task("t2", "p2")]),
      { kind: "other" },
      null,
      report([task("t3", "p1"), task("t4", null)]),
    ];
    expect(reportedProjects(metadata)).toEqual({ projectIds: ["p1", "p2"], unresolvedTaskIds: [] });
  });

  it("skips withheld reports: their content never reached the agent", () => {
    expect(reportedProjects([report([task("t1", "p1")], true)])).toEqual({ projectIds: [], unresolvedTaskIds: [] });
  });

  it("returns the tasks of older reports, which do not record their project, for a lookup", () => {
    expect(reportedProjects([report([task("t1"), task("t2", "p2")])])).toEqual({
      projectIds: ["p2"],
      unresolvedTaskIds: ["t1"],
    });
  });
});

describe("isWithheldReport", () => {
  it("is true only for a delegation report marked withheld", () => {
    expect(isWithheldReport(report([task("t1", "p1")], true))).toBe(true);
    expect(isWithheldReport(report([task("t1", "p1")]))).toBe(false);
    expect(isWithheldReport({ withheld: true })).toBe(false);
    expect(isWithheldReport(undefined)).toBe(false);
  });
});

describe("ownTaskWaitsForReport", () => {
  it("is true for an own task not settled yet, which a withheld report would leave waiting", () => {
    expect(ownTaskWaitsForReport({ status: "in_progress" })).toBe(true);
    expect(ownTaskWaitsForReport({ status: "backlog" })).toBe(true);
  });

  it("is false without an own task or once it has settled", () => {
    expect(ownTaskWaitsForReport(null)).toBe(false);
    expect(ownTaskWaitsForReport({ status: "review" })).toBe(false);
    expect(ownTaskWaitsForReport({ status: "done" })).toBe(false);
    expect(ownTaskWaitsForReport({ status: "blocked" })).toBe(false);
  });
});
