import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { CardFrame } from "./card-parts";
import { MoveBody } from "./money/move-body";

// Found in review: a single card's permission named a token by its maker's 200-letter name, and
// the frame, which clips what runs past its edge, cut it off at phone width while Allow showed.
it("wraps a word too long for the card rather than clipping it, whatever the card says", () => {
  const token = "A".repeat(200);
  const html = renderToStaticMarkup(
    <CardFrame label="Sell" phase="open">
      <MoveBody
        exchange={{ scene: null, result: null, facts: [] }}
        face={{
          title: "Sell your shares",
          action: "Sell",
          working: "Selling",
          context: null,
          figures: [],
          finePrint: null,
          receipt: { title: "Sold", detail: null, amount: null },
          leaves: [{ says: `From now on, it lets 0x2222…2222 spend your ${token}.` }],
        }}
        ready
      />
    </CardFrame>,
  );
  expect(html).toContain(token);
  // The element that clips also wraps, and every word inside it inherits that.
  const frame = /<section[^>]*class="([^"]*)"/u.exec(html)?.[1]?.split(" ") ?? [];
  expect(frame).toContain("overflow-hidden");
  expect(frame).toContain("break-words");
});
