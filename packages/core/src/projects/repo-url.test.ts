import { describe, expect, it } from "vitest";
import {
  defaultRepoName,
  isRepoName,
  parseRepoUrl,
  providerOfHost,
  repoApiBase,
  repoCloneUrl,
  repoProtectionUrl,
  repoTokenUrl,
  repoWebUrl,
} from "./repo-url";

describe("parseRepoUrl", () => {
  it.each([
    ["https://github.com/acme/site", "github.com", "acme/site"],
    ["https://github.com/acme/site.git", "github.com", "acme/site"],
    ["https://github.com/Acme/Site/tree/main/src", "github.com", "Acme/Site"],
    ["  https://github.com/acme/site/  ", "github.com", "acme/site"],
    ["git@github.com:acme/site.git", "github.com", "acme/site"],
    ["ssh://git@github.com/acme/site.git", "github.com", "acme/site"],
    ["https://gitlab.com/group/sub/site", "gitlab.com", "group/sub/site"],
    ["https://gitlab.com/group/sub/site/-/tree/main", "gitlab.com", "group/sub/site"],
    ["https://GitLab.Example.com:8443/team/site.git", "gitlab.example.com:8443", "team/site"],
    ["ssh://git@gitlab.example.com:2222/team/site.git", "gitlab.example.com", "team/site"],
  ])("reads %s", (input, host, path) => {
    expect(parseRepoUrl(input)).toEqual({ host, path });
  });

  it.each([
    "",
    "github.com/acme/site",
    "http://github.com/acme/site",
    "ftp://github.com/acme/site",
    "https://github.com/acme",
    "https://github.com/acme/../site",
    "https://localhost/acme/site",
    "https://10.0.0.1/acme/site",
    "https://github.com/acme/si te",
  ])("refuses %s", (input) => {
    expect(parseRepoUrl(input)).toBeNull();
  });
});

describe("repo addresses", () => {
  const repo = { host: "gitlab.example.com:8443", path: "team/site" };

  it("derives the clone and web URLs", () => {
    expect(repoCloneUrl(repo)).toBe("https://gitlab.example.com:8443/team/site.git");
    expect(repoWebUrl(repo)).toBe("https://gitlab.example.com:8443/team/site");
  });

  it("knows the providers of the public hosts only", () => {
    expect(providerOfHost("github.com")).toBe("github");
    expect(providerOfHost("gitlab.com")).toBe("gitlab");
    expect(providerOfHost("git.example.com")).toBeNull();
  });

  it("links to the token and protection settings", () => {
    const github = { host: "github.com", path: "acme/site" };
    const url = new URL(repoTokenUrl("github", github, "Abotica site"));
    expect(url.origin + url.pathname).toBe("https://github.com/settings/personal-access-tokens/new");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      name: "Abotica site",
      target_name: "acme",
      contents: "write",
      pull_requests: "write",
      actions: "read",
      statuses: "read",
    });
    expect(repoTokenUrl("gitlab", repo, "x")).toBe("https://gitlab.example.com:8443/team/site/-/settings/access_tokens");
    expect(repoProtectionUrl("github", github)).toBe("https://github.com/acme/site/settings/branches");
    expect(repoProtectionUrl("gitlab", repo)).toBe("https://gitlab.example.com:8443/team/site/-/settings/repository");
  });

  it("picks the API of each provider", () => {
    expect(repoApiBase("github", "github.com")).toBe("https://api.github.com");
    expect(repoApiBase("github", "github.example.com")).toBe("https://github.example.com/api/v3");
    expect(repoApiBase("gitlab", "gitlab.example.com:8443")).toBe("https://gitlab.example.com:8443/api/v4");
  });
});

describe("repo names", () => {
  it("defaults to the repository's own name, made safe", () => {
    expect(defaultRepoName("acme/Site.Web")).toBe("site.web");
    expect(defaultRepoName("group/sub/My Repo")).toBe("my-repo");
    expect(defaultRepoName("acme/__")).toBe("repo");
  });

  it("accepts folder names only", () => {
    expect(isRepoName("site")).toBe(true);
    expect(isRepoName("site_v2.web-app")).toBe(true);
    expect(isRepoName("")).toBe(false);
    expect(isRepoName(".git")).toBe(false);
    expect(isRepoName("Site")).toBe(false);
    expect(isRepoName("a/b")).toBe(false);
  });
});
