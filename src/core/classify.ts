import type { Category } from "./types.ts";

interface Rule {
  category: Category;
  strong?: RegExp[];
  weak?: RegExp[];
  veto?: RegExp[];
}

const RULES: Rule[] = [
  {
    category: "earbuds",
    strong: [
      /\b(tws|true\s*wireless|earbuds?|ear\s*buds?|airdopes|airpods|neckband)\b/i,
      /\bin[-\s]?ear\s+(?:wireless\s+)?(?:head|ear)phones?\b/i,
      /\bbullets\s+z\d/i,
    ],
    weak: [/\bipx\d\b/i, /playtime/i, /\bearphones?\b/i],
    veto: [
      /\b(case|cover|pouch|ear\s*pads?|ear\s*cushions?|ear\s*tips?|hinge|protector|stand|holder|replacement|spare)\b/i,
      /\bcompatible\s+with\b/i,
      /\bfor\s+(?:sony|bose|jbl|sennheiser|marshall|boat|noise|apple|samsung)\b/i,
    ],
  },
  {
    category: "headphone",
    strong: [
      /\b(over[-\s]?ear|on[-\s]?ear)\b/i,
      /\bheadphones?\b/i,
      /\bheadset\b/i,
      /\bwh-\d{4}|\bqc\d{2}\b|quietcomfort/i,
    ],
    weak: [/\banc\b|noise\s*cancell/i, /\bdriver\b/i],
    veto: [
      /\bearbuds?\b|\btws\b/i,
      /\b(case|cover|pouch|ear\s*pads?|ear\s*cushions?|hinge|protector|stand|holder|replacement|spare)\b/i,
      /\bcompatible\s+with\b/i,
      /\bfor\s+(?:sony|bose|jbl|sennheiser|marshall|boat|noise|apple|samsung)\b/i,
    ],
  },
  {
    // Keypad phones match every smartphone signal a title can carry. Listed
    // before the phone rule. Titles that say so are caught by the words below;
    // titles that do not are caught by the model patterns, because keypad
    // lineages have distinct names: pure-digit Nokias (130, 150), the Moto
    // A-series, and LAVA's A1/A2/A3/Hero/Shakti/Spark. Letter-suffixed or
    // modern lines (Nokia G42, Moto E13, LAVA Blaze) never match, and the
    // vetoes keep any title carrying "android" or "N gb ram" out entirely.
    category: "featurephone",
    strong: [
      /\bkeypad\b/i,
      /\bfeature\s*phone\b/i,
      /\b(basic|senior\s*citizen)\s*phone\b/i,
      /\bnokia\s+\d{3}\b/i,
      /\bmoto(?:rola)?\s+a\d{2,3}\b/i,
      /\blava\s+(a[123]|hero|shakti|spark)\b/i,
    ],
    weak: [
      /\bmp3\s*player\b/i,
      /\bwireless\s*fm\b/i,
      /\btorch\b/i,
      /\b[12]\.\d\s*inch\b/i,
    ],
    veto: [/\b\d+\s*gb\s*ram\b/i, /\bandroid\b/i],
  },
  {
    category: "phone",
    strong: [
      /\b(smartphone|mobile\s*phone)\b/i,
      /\(\s*[\w\s]+,\s*\d+\s*(?:gb|tb)\s*\)/i,
      /\biphone\s*\d/i,
      /\bgalaxy\s+[amszf]\d/i,
    ],
    weak: [
      /\b\d+\s*gb\s*ram\b/i,
      /\b5g\b/i,
      /\bdual\s*sim\b/i,
      /\b(poco|redmi|realme|narzo|iqoo|vivo|oppo|infinix|tecno|lava|motorola|moto|nothing\s*phone)\b/i,
    ],
    veto: [
      /\bkeypad\b|\bfeature\s*phone\b/i,
      /\b(case|cover|tempered|screen\s*guard|protector|charger|cable|adapter|holder|mount|stand|pouch|skin|sticker|lens\s*protector|back\s*cover|flip\s*cover)\b/i,
      /\b(earphones?|earbuds?|headphones?|headset|neckband|tws|speaker|smart\s*watch|smartwatch|power\s*bank|powerbank|tablet|laptop)\b/i,
      /\bcompatible\s+with\b/i,
    ],
  },
  {
    category: "smartwatch",
    strong: [/\bsmart\s*watch\b|\bsmartwatch\b|\bfitness\s*band\b/i],
    weak: [/\bamoled\s+display\b.*\bwatch\b/i, /\bbluetooth\s+calling\b/i],
  },
  {
    category: "laptop",
    strong: [/\blaptop\b|\bnotebook\b|\bmacbook\b|\bchromebook\b/i],
    weak: [/\b(i[3579]|ryzen|celeron)\b/i, /\bwindows\s*11\b/i],
  },
  {
    category: "tablet",
    strong: [/\btablet\b|\bipad\b|\btab\s+[a-z]?\d/i],
    veto: [/\bcase\b|\bcover\b|\bkeyboard\b/i],
  },
  {
    category: "tv",
    strong: [
      /\b(smart\s*)?(led|qled|oled)\s*tv\b/i,
      /\btelevision\b/i,
      /\b\d{2}\s*inch\b.*\btv\b/i,
    ],
  },
  {
    category: "camera",
    strong: [/\bdslr\b|\bmirrorless\b|\baction\s*camera\b|\bgopro\b/i],
    veto: [/\bcamera\s*(lens\s*)?(protector|cover)\b/i],
  },
  {
    category: "accessory",
    strong: [
      /\b(back\s*cover|flip\s*cover|tempered\s*glass|screen\s*(guard|protector)|charging\s*cable|usb\s*cable|charger|adapter|power\s*bank|powerbank|car\s*mount|mobile\s*holder|selfie\s*stick|stylus|memory\s*card|sim\s*ejector)\b/i,
      /\b(carrying\s*case|hard\s*case|silicone\s*case|travel\s*case|headphone\s*case|headphones\s*case)\b/i,
      /\b(ear\s*pads?|ear\s*cushions?|earpads?|ear\s*tips?|eartips?|headband\s*(cover|pad)|ear\s*cups?\s*protector)\b/i,
      /\b(hinge|replacement\s*part|spare\s*part|repair\s*kit)\b/i,
      /\bcompatible\s+with\b/i,
      /\bfor\s+(?:apple|samsung|oneplus|xiaomi|redmi|poco|realme|vivo|oppo|iqoo|sony|bose|jbl|sennheiser|marshall|boat|noise)\b/i,
    ],
  },
];

export interface Classification {
  category: Category;
  confidence: number;
  evidence: string[];
}

function productHead(title: string): string {
  const head = title.split("|")[0];
  return (head.length >= 12 ? head : title).slice(0, 90);
}

export function classify(title: string, url = ""): Classification {
  const text = `${title} ${url.replace(/[-/]/g, " ")}`;
  const head = productHead(title);
  const scores = new Map<Category, { score: number; evidence: string[] }>();

  for (const rule of RULES) {
    if (rule.veto?.some((r) => r.test(head))) continue;
    let score = 0;
    const evidence: string[] = [];
    const strongText = rule.category === "accessory" ? head : text;
    for (const r of rule.strong ?? []) {
      const m = strongText.match(r);
      if (m) {
        score += 3;
        evidence.push(m[0].trim());
      }
    }
    for (const r of rule.weak ?? []) {
      const m = text.match(r);
      if (m) {
        score += 1;
        evidence.push(m[0].trim());
      }
    }
    if (score > 0) scores.set(rule.category, { score, evidence });
  }

  if (scores.size === 0) {
    return { category: "unknown", confidence: 0, evidence: [] };
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const [topCat, top] = sorted[0];
  const runnerUp = sorted[1]?.[1].score ?? 0;
  const margin = (top.score - runnerUp) / Math.max(top.score, 1);
  const confidence = Math.min(
    1,
    (Math.min(top.score, 6) / 6) * 0.6 + margin * 0.4,
  );

  return {
    category: topCat,
    confidence: Math.round(confidence * 100) / 100,
    evidence: top.evidence.slice(0, 4),
  };
}

const COMPATIBLE: Partial<Record<Category, Category[]>> = {
  earbuds: ["headphone"],
  headphone: ["earbuds"],
};

export function categoryMatches(
  wanted: Category,
  actual: Category,
): boolean {
  if (wanted === "unknown") return actual !== "accessory";
  if (wanted === actual) return true;
  return COMPATIBLE[wanted]?.includes(actual) ?? false;
}
