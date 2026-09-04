import { defineConfig } from "vitest/config";

/**
 * Runs `failing.fixture.ts` and nothing else. Exists so R4 can prove the
 * evidence harness retains a real failure's identity without ever putting an
 * intentionally-red file where the real suite would collect it.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/fixtures/failing.fixture.ts"],
  },
});
