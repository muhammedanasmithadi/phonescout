import { assertEquals } from "@std/assert";

import { sparkline } from "../src/ui/render.ts";

Deno.test("a sparkline maps the range onto eight levels", () => {
  assertEquals(sparkline([]), "");
  assertEquals(sparkline([5, 5, 5]), "▄▄▄"); // flat reads as steady
  assertEquals(sparkline([1, 9]), "▁█");
  assertEquals(sparkline([10, 1, 5]), "█▁▄");
});
