export const SIGNS = [
  "aries",
  "taurus",
  "gemini",
  "cancer",
  "leo",
  "virgo",
  "libra",
  "scorpio",
  "sagittarius",
  "capricorn",
  "aquarius",
  "pisces",
] as const;

export type Sign = (typeof SIGNS)[number];

export const SIGN_LABELS: Record<Sign, string> = {
  aries: "Aries",
  taurus: "Taurus",
  gemini: "Gemini",
  cancer: "Cancer",
  leo: "Leo",
  virgo: "Virgo",
  libra: "Libra",
  scorpio: "Scorpio",
  sagittarius: "Sagittarius",
  capricorn: "Capricorn",
  aquarius: "Aquarius",
  pisces: "Pisces",
};

/** Conventional tropical-zodiac date ranges, used by the `{dates}` text token. */
export const SIGN_DATES: Record<Sign, string> = {
  aries: "Mar 21 – Apr 19",
  taurus: "Apr 20 – May 20",
  gemini: "May 21 – Jun 20",
  cancer: "Jun 21 – Jul 22",
  leo: "Jul 23 – Aug 22",
  virgo: "Aug 23 – Sep 22",
  libra: "Sep 23 – Oct 22",
  scorpio: "Oct 23 – Nov 21",
  sagittarius: "Nov 22 – Dec 21",
  capricorn: "Dec 22 – Jan 19",
  aquarius: "Jan 20 – Feb 18",
  pisces: "Feb 19 – Mar 20",
};

export function isSign(value: unknown): value is Sign {
  return typeof value === "string" && (SIGNS as readonly string[]).includes(value);
}
