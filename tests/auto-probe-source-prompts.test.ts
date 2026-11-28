import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import consola from "consola"
import { rejects } from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  createSourceTaskPrompts,
  getCachedSourceTaskPrompts,
  sampleHardSnippet,
} from "~/lib/auto-probe-source-prompts"

const roots = new Set<string>()
const makeRoot = async (): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-source-prompts-"))
  roots.add(root)
  return root
}

const writeTaskSources = async (root: string): Promise<void> => {
  const files = [
    ["src/lib/auth/request-auth.ts", 'export const auth = "current-auth"\n'],
    ["src/server.ts", 'export const server = "current-server"\n'],
    ["src/lib/config/index.ts", 'export const config = "current-config"\n'],
    ["tests/request-auth.test.ts", 'export const test = "current-test"\n'],
  ] as const
  await Promise.all(
    files.map(async ([file, text]) => {
      const target = path.join(root, file)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, text)
    }),
  )
}

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => fs.rm(root, { recursive: true, force: true })),
  )
  roots.clear()
  mock.restore()
})

describe("runtime source prompts", () => {
  test("constructs all four tasks from the four complete current source files", async () => {
    const root = await makeRoot()
    await writeTaskSources(root)

    const tasks = await createSourceTaskPrompts(path.join(root, "src"))

    expect(tasks.map(({ id }) => id)).toEqual([
      "task-correctness",
      "task-behavior",
      "task-cancellation",
      "task-concurrency",
    ])
    expect(tasks.map(({ tier }) => tier)).toEqual([
      "intelligence",
      "intelligence",
      "balance",
      "intelligence",
    ])
    for (const task of tasks) {
      expect(task.sources.map(({ file }) => file)).toEqual(
        [
          path.join(root, "src/lib/auth/request-auth.ts"),
          path.join(root, "src/server.ts"),
          path.join(root, "src/lib/config/index.ts"),
          path.join(root, "tests/request-auth.test.ts"),
        ].map((file) =>
          path.relative(process.cwd(), file).split(path.sep).join("/"),
        ),
      )
      expect(task.prompt).toContain("current-auth")
      expect(task.prompt).toContain("current-server")
      expect(task.prompt).toContain("current-config")
      expect(task.prompt).toContain("current-test")
    }
  })

  test("caches complete task text across runtime rounds", async () => {
    const root = await makeRoot()
    await writeTaskSources(root)
    const sourceRoot = path.join(root, "src")
    const first = await getCachedSourceTaskPrompts(sourceRoot)
    await fs.writeFile(
      path.join(root, "src/server.ts"),
      'export const server = "updated-server"\n',
    )

    const second = await getCachedSourceTaskPrompts(sourceRoot)
    expect(second).toEqual(first)
    expect(second[0].prompt).toContain("current-server")
    expect(second[0].prompt).not.toContain("updated-server")
  })

  test("skips only missing deployed sources with a sanitized warning", async () => {
    const root = await makeRoot()
    const missing = path.join(root, "private-deployment-path", "src")
    const warning = spyOn(consola, "warn")

    expect(await getCachedSourceTaskPrompts(missing)).toEqual([])
    expect(await sampleHardSnippet(missing)).toBeUndefined()
    const messages = warning.mock.calls.map((call) => String(call[0]))
    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(messages.join("\n")).toContain("ENOENT")
    expect(messages.join("\n")).not.toContain(missing)
    warning.mockRestore()
  })

  test("reports non-ENOENT source read failures instead of narrowing the pool", async () => {
    const root = await makeRoot()
    await writeTaskSources(root)
    await fs.rm(path.join(root, "src/lib/auth/request-auth.ts"))
    await fs.mkdir(path.join(root, "src/lib/auth/request-auth.ts"))

    await rejects(getCachedSourceTaskPrompts(path.join(root, "src")), {
      code: "EISDIR",
    })
  })
})
