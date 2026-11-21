import { expect, test } from "bun:test";
import { Preview, type PreviewTarget } from "./preview";

test("Automatisch wartet beim Zielwechsel und blendet nach Inaktivität aus", async () => {
  const starts: PreviewTarget[] = [];
  const stops: PreviewTarget[] = [];
  let idle = 0;
  const preview = new Preview({
    start: async target => { starts.push(target); return true; },
    stop: async target => { stops.push(target); },
    idle: () => { idle++; },
  }, { settle: 20, hold: 35, idle: 180 });
  try {
    preview.work(4);
    preview.work("win:5");
    preview.work(4);
    await Bun.sleep(50);
    expect(starts).toEqual([4]);
    preview.work("win:5");
    await Bun.sleep(50);
    expect(starts).toEqual([4, "win:5"]);
    expect(stops).toEqual([4]);
    await Bun.sleep(180);
    expect(stops).toEqual([4, "win:5"]);
    expect(idle).toBe(1);
  } finally { preview.clear(); }
});

test("Eine neue manuelle Auswahl setzt sich gegen verspätete Starts durch", async () => {
  const starts: PreviewTarget[] = [];
  const stops: PreviewTarget[] = [];
  let ready!: (ok: boolean) => void;
  const preview = new Preview({
    start: async target => {
      starts.push(target);
      if (target === 4) return new Promise(resolve => { ready = resolve; });
      return true;
    },
    stop: async target => { stops.push(target); },
    idle: () => {},
  }, { settle: 20, hold: 35, idle: 60 });
  try {
    preview.work(4);
    preview.pin("win:5");
    expect(preview.shows(4)).toBe(false);
    ready(true);
    await Bun.sleep(10);
    preview.work(6);
    await Bun.sleep(90);
    expect(starts).toEqual([4, "win:5"]);
    expect(stops).toEqual([4]);
    expect(preview.shows("win:5")).toBe(true);
  } finally { preview.clear(); }
});
