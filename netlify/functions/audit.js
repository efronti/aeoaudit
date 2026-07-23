/**
 * Business AEO Audit - Netlify Function
 * Grades a business website on how ready it is to be crawled, understood and
 * cited by AI answer engines (ChatGPT, Claude, Perplexity, Google AI Overviews).
 *
 * Same 114-raw-point rubric as the local Flask version, ported to Node + cheerio
 * so it can run as a Netlify serverless function.
 */
const cheerio = require("cheerio");

const UA = "Mozilla/5.0 (compatible; AEOAuditBot/1.0; +https://example.com/bot)";
const AI_BOTS = ["ChatGPT-User", "OAI-SearchBot", "PerplexityBot", "Claude-User", "ClaudeBot", "Google-Extended"];
const LANDMARKS = ["header", "nav", "main", "article", "section", "footer"];
const QUESTION_START_RE = /^\s*(who|what|why|how|when|where|which|can|do|does|is|are)\b/i;
const STAT_RE = /\b\d[\d,]*\.?\d*\s?(%|percent|years?|homes?|days?|dollars?|\$|sq\.?\s?ft|hours?|clients?|deals?|properties)\b/i;

const MAX_POINTS = { fetchability: 43, seo: 21, semantic: 13, answer_engine: 31, content_quality: 6 };
const TOTAL_MAX = Object.values(MAX_POINTS).reduce((a, b) => a + b, 0);

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: controller.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, text: buf.toString("utf-8"), bytes: buf.length, ok: true };
  } finally {
    clearTimeout(id);
  }
}

function normalizeUrl(raw) {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

function checkRobotsBlocking(robotsTxt) {
  const lower = robotsTxt.toLowerCase();
  const blocked = [];
  let allowed = 0;
  const disallowRootRe = /disallow:\s*\/\s*(\r?\n|$)/;

  for (const bot of AI_BOTS) {
    const botL = bot.toLowerCase();
    let segment = "";
    if (lower.includes(`user-agent: ${botL}`)) {
      const idx = lower.indexOf(`user-agent: ${botL}`);
      const nextIdx = lower.indexOf("user-agent:", idx + 1);
      segment = lower.slice(idx, nextIdx !== -1 ? nextIdx : idx + 400);
    } else {
      const wcIdx = lower.indexOf("user-agent: *");
      if (wcIdx !== -1) {
        const nextIdx = lower.indexOf("user-agent:", wcIdx + 1);
        segment = lower.slice(wcIdx, nextIdx !== -1 ? nextIdx : wcIdx + 400);
      }
    }
    if (disallowRootRe.test(segment)) blocked.push(bot);
    else allowed += 1;
  }
  return { blocked, allowed };
}

async function audit(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const started = Date.now();
  const result = { url, categories: {}, checks: [], raw_points: 0, max_points: TOTAL_MAX };

  const addCheck = (category, name, points, max, detail) =>
    result.checks.push({ category, name, points: round1(points), max, detail });

  const httpsOk = url.startsWith("https://");

  let resp;
  try {
    resp = await fetchWithTimeout(url);
  } catch (e) {
    addCheck("fetchability", "Reachable without bot blocking", 0, 18, "Request failed / timed out");
    addCheck("fetchability", "Served over HTTPS", httpsOk ? 4 : 0, 4, httpsOk ? "URL uses HTTPS" : "URL does not use HTTPS");
    addCheck("fetchability", "Reasonable page size (<2.5MB)", 0, 3, "N/A - fetch failed");
    addCheck("fetchability", "robots.txt allows AI search crawlers", 0, 10, "Could not verify - fetch failed");
    addCheck("fetchability", "Content rendered server-side (visible without JS)", 0, 8, "N/A - fetch failed");
    result.categories.fetchability = httpsOk ? 4 : 0;
    result.fatal = true;
    finish(result);
    return result;
  }

  const html = resp.text;
  const sizeKb = resp.bytes / 1024;
  const statusOk = resp.status >= 200 && resp.status < 400;
  const $ = cheerio.load(html);

  // ---- Fetchability ----
  let fetchCat = 0;
  const reachablePts = statusOk ? 18 : 0;
  addCheck("fetchability", "Reachable without bot blocking", reachablePts, 18,
    `HTTP ${resp.status}` + (statusOk ? " - no bot challenge detected" : " - blocked/error"));
  fetchCat += reachablePts;

  const httpsPts = httpsOk ? 4 : 0;
  addCheck("fetchability", "Served over HTTPS", httpsPts, 4, httpsOk ? "URL uses HTTPS" : "URL does not use HTTPS");
  fetchCat += httpsPts;

  const sizePts = sizeKb < 2500 ? 3 : sizeKb < 5000 ? 1 : 0;
  addCheck("fetchability", "Reasonable page size (<2.5MB)", sizePts, 3, `${sizeKb.toFixed(1)} KB downloaded`);
  fetchCat += sizePts;

  const parsedUrl = new URL(url);
  const robotsUrl = `${parsedUrl.origin}/robots.txt`;
  let robotsTxt = "";
  try {
    const robotsResp = await fetchWithTimeout(robotsUrl, 8000);
    if (robotsResp.status === 200) robotsTxt = robotsResp.text;
  } catch (e) { /* no robots.txt */ }

  let robotsPts, robotsDetail;
  if (robotsTxt) {
    const { blocked } = checkRobotsBlocking(robotsTxt);
    robotsPts = blocked.length === 0 ? 10 : Math.max(0, 10 - 2 * blocked.length);
    robotsDetail = blocked.length === 0
      ? "All critical AI search bots are allowed."
      : `Blocked: ${blocked.join(", ")}`;
  } else {
    robotsPts = 10;
    robotsDetail = "No robots.txt found - defaults to allowed.";
  }
  addCheck("fetchability", "robots.txt allows AI search crawlers", robotsPts, 10, robotsDetail);
  fetchCat += robotsPts;

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(" ").length : 0;
  const ssrPts = wordCount >= 150 ? 8 : wordCount >= 50 ? 4 : 0;
  addCheck("fetchability", "Content rendered server-side (visible without JS)", ssrPts, 8,
    `Body contains ${wordCount} words of server-rendered text.`);
  fetchCat += ssrPts;

  result.categories.fetchability = fetchCat;

  // ---- Core SEO ----
  let seoCat = 0;
  const titleTag = ($("title").first().text() || "").trim();
  const tlen = titleTag.length;
  const titlePts = tlen >= 25 && tlen <= 65 ? 4 : (tlen >= 10 && tlen < 25) || (tlen > 65 && tlen <= 80) ? 2 : 0;
  addCheck("seo", "Title tag (25-65 characters)", titlePts, 4, `Title is ${tlen} characters: "${titleTag}"`);
  seoCat += titlePts;

  const metaDesc = ($('meta[name="description"]').attr("content") || "").trim();
  const dlen = metaDesc.length;
  const descPts = dlen >= 80 && dlen <= 175 ? 4 : metaDesc ? 2 : 0;
  addCheck("seo", "Meta description (80-175 characters)", descPts, 4,
    metaDesc ? `${dlen} characters` : 'Missing <meta name="description">');
  seoCat += descPts;

  const canonicalHref = $('link[rel="canonical"]').attr("href");
  const canonicalPts = canonicalHref ? 3 : 0;
  addCheck("seo", "Canonical URL declared", canonicalPts, 3,
    canonicalHref ? `Canonical: ${canonicalHref}` : "No canonical tag found");
  seoCat += canonicalPts;

  const ogTitle = $('meta[property="og:title"]').attr("content");
  const ogDesc = $('meta[property="og:description"]').attr("content");
  const ogImage = $('meta[property="og:image"]').attr("content");
  const ogFound = [ogTitle, ogDesc, ogImage].filter(Boolean).length;
  const ogPts = round1((3 * ogFound) / 3);
  addCheck("seo", "OpenGraph tags (title, description, image)", ogPts, 3, `${ogFound}/3 OpenGraph tags present`);
  seoCat += ogPts;

  const twCard = $('meta[name="twitter:card"]').attr("content");
  const twPts = twCard ? 2 : 0;
  addCheck("seo", "Twitter Card tag", twPts, 2, twCard ? `twitter:card = ${twCard}` : "No twitter:card tag");
  seoCat += twPts;

  const lang = $("html").attr("lang");
  const langPts = lang ? 1 : 0;
  addCheck("seo", "<html lang> attribute", langPts, 1, lang ? `lang="${lang}"` : "No lang attribute");
  seoCat += langPts;

  let sitemapUrl = null;
  const sitemapInRobots = /sitemap:/i.test(robotsTxt);
  if (sitemapInRobots) {
    const m = robotsTxt.split(/\r?\n/).find((l) => /^sitemap:/i.test(l.trim()));
    if (m) sitemapUrl = m.split(":").slice(1).join(":").trim();
  }
  if (!sitemapUrl) sitemapUrl = `${parsedUrl.origin}/sitemap.xml`;

  let sitemapFound = false;
  let sitemapUrlsCount = 0;
  try {
    const sitemapResp = await fetchWithTimeout(sitemapUrl, 8000);
    if (sitemapResp.status === 200 && sitemapResp.text.trim().startsWith("<")) {
      sitemapFound = true;
      const locMatches = sitemapResp.text.match(/<loc>/gi);
      sitemapUrlsCount = locMatches ? locMatches.length : 0;
    }
  } catch (e) { /* no sitemap */ }
  const sitemapPts = (sitemapFound ? 2 : 0) + (sitemapFound && sitemapInRobots ? 2 : 0);
  addCheck("seo", "XML sitemap exists (and referenced in robots.txt)", sitemapPts, 4,
    sitemapFound ? `Found sitemap at ${sitemapUrl} with ${sitemapUrlsCount} URLs` : "No sitemap found");
  seoCat += sitemapPts;

  result.categories.seo = seoCat;

  // ---- Semantic HTML ----
  let semCat = 0;
  const h1Count = $("h1").length;
  const h1Pts = h1Count === 1 ? 3 : h1Count > 0 ? 1 : 0;
  addCheck("semantic", "Exactly one <h1>", h1Pts, 3, `Found ${h1Count} <h1> elements`);
  semCat += h1Pts;

  const headingEls = $("h1, h2, h3, h4, h5, h6").toArray();
  const levels = headingEls.map((el) => parseInt(el.tagName.slice(1), 10));
  let skipped = false;
  for (let i = 0; i < levels.length - 1; i++) {
    if (levels[i + 1] - levels[i] > 1) { skipped = true; break; }
  }
  const hierPts = skipped ? 1 : 3;
  addCheck("semantic", "Heading hierarchy (no skipped levels)", hierPts, 3,
    skipped ? "Heading levels skip (e.g. <h1> to <h3>)" : "No skipped heading levels");
  semCat += hierPts;

  const foundLandmarks = LANDMARKS.filter((tag) => $(tag).length > 0 || $(`[role="${tag}"]`).length > 0);
  const landmarkPts = round1((4 * foundLandmarks.length) / LANDMARKS.length);
  addCheck("semantic", "Semantic HTML landmarks", landmarkPts, 4,
    foundLandmarks.length ? `Landmarks present: ${foundLandmarks.join(", ")}` : "No landmarks found");
  semCat += landmarkPts;

  const imgs = $("img").toArray();
  const imgsWithAlt = imgs.filter((i) => ($(i).attr("alt") || "").trim().length > 0);
  const altPts = imgs.length === 0 ? 3 : round1((3 * imgsWithAlt.length) / imgs.length);
  addCheck("semantic", "Image alt text coverage", altPts, 3,
    imgs.length ? `${imgsWithAlt.length}/${imgs.length} images have an alt attribute` : "No images found (n/a, full credit)");
  semCat += altPts;

  result.categories.semantic = semCat;

  // ---- Answer Engine Signals ----
  let aeCat = 0;
  let llmsFound = false;
  try {
    const r = await fetchWithTimeout(`${parsedUrl.origin}/llms.txt`, 8000);
    llmsFound = r.status === 200;
  } catch (e) {}
  addCheck("answer_engine", "/llms.txt manifest at site root", llmsFound ? 5 : 0, 5,
    llmsFound ? "/llms.txt found" : "/llms.txt not found (404 or unreachable)");
  aeCat += llmsFound ? 5 : 0;

  let llmsFullFound = false;
  try {
    const r = await fetchWithTimeout(`${parsedUrl.origin}/llms-full.txt`, 8000);
    llmsFullFound = r.status === 200;
  } catch (e) {}
  addCheck("answer_engine", "/llms-full.txt (bonus full-content dump)", llmsFullFound ? 1 : 0, 1,
    llmsFullFound ? "/llms-full.txt found" : "/llms-full.txt not present");
  aeCat += llmsFullFound ? 1 : 0;

  const jsonLdCount = $('script[type="application/ld+json"]').length;
  const jsonLdPts = jsonLdCount > 0 ? 6 : 0;
  addCheck("answer_engine", "JSON-LD structured data", jsonLdPts, 6,
    jsonLdCount ? `${jsonLdCount} JSON-LD block(s) found` : "No JSON-LD structured data");
  aeCat += jsonLdPts;

  const sameAs = /sameas/i.test(html);
  const byline = $('[rel="author"]').length > 0 || /class="[^"]*author[^"]*"/i.test(html);
  const authorityPts = sameAs && byline ? 3 : sameAs || byline ? 1.5 : 0;
  addCheck("answer_engine", "Author / Organization authority signals", authorityPts, 3,
    authorityPts ? "Found author/sameAs signals" : "No author byline or Organization sameAs found");
  aeCat += authorityPts;

  const dateModified = /datemodified/i.test(html) || /datepublished/i.test(html);
  const freshPts = dateModified ? 2 : 1;
  addCheck("answer_engine", "Content freshness (dateModified within 12 months)", freshPts, 2,
    dateModified ? "dateModified found in structured data" : "No dateModified in structured data (acceptable for evergreen pages)");
  aeCat += freshPts;

  const hasBlog = /\/(blog|news|articles)\b/i.test(html);
  const depthPts = Math.min(4,
    (sitemapUrlsCount >= 1 ? 1 : 0) +
    (sitemapUrlsCount >= 10 ? 2 : sitemapUrlsCount >= 3 ? 1 : 0) +
    (hasBlog ? 1 : 0));
  addCheck("answer_engine", "Content depth (sitemap URL count, blog, recency)", depthPts, 4,
    `${sitemapUrlsCount} URLs in sitemap.` + (hasBlog ? " Blog/news section detected." : ""));
  aeCat += depthPts;

  const $clone = cheerio.load(html);
  $clone("script, style, nav, header, footer, noscript").remove();
  const readableText = $clone("main, article").first().text().trim() ||
    $clone("body").text().replace(/\s+/g, " ").trim();
  const rChars = readableText.length;
  const readPts = rChars > 1000 ? 5 : rChars > 300 ? 3 : rChars > 0 ? 1 : 0;
  addCheck("answer_engine", "Mozilla Readability extraction", readPts, 5,
    rChars ? `Extracted ${rChars} chars of readable long-form content` : "Could not extract readable content");
  aeCat += readPts;

  const phoneFound = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/.test(bodyText);
  const addressFound = /\b\d{1,6}\s+\w+(\s\w+){0,3}\s+(street|st|ave|avenue|road|rd|blvd|drive|dr|lane|ln|way|suite|ste)\b/i.test(bodyText);
  const hoursFound = /\b(mon|tue|wed|thu|fri|sat|sun)\w*\s*[-:]\s*\d/i.test(bodyText) || /\d{1,2}(am|pm)\s*-\s*\d{1,2}(am|pm)/i.test(bodyText);
  const emailFound = /[\w.+-]+@[\w-]+\.[\w.-]+/.test(bodyText);
  const serviceAreaFound = /service area|serving|areas we serve|we serve/i.test(bodyText);
  const napComponents = [phoneFound, addressFound, hoursFound || serviceAreaFound, emailFound];
  const napPts = round1((5 * napComponents.filter(Boolean).length) / napComponents.length);
  const missing = [];
  if (!addressFound) missing.push("address");
  if (!(hoursFound || serviceAreaFound)) missing.push("hours/service area");
  if (!emailFound) missing.push("email");
  let napDetail = `Found: ${phoneFound ? "phone" : "none"}`;
  napDetail += missing.length ? `. Missing: ${missing.join(", ")}.` : ". All NAP elements present.";
  addCheck("answer_engine", "Contact info (phone, address, hours, service area)", napPts, 5, napDetail);
  aeCat += napPts;

  result.categories.answer_engine = aeCat;

  // ---- Content Quality ----
  let cqCat = 0;
  const paragraphs = $("p").toArray();
  let firstP = "";
  for (const p of paragraphs) {
    const t = $(p).text().trim();
    if (t.split(/\s+/).length > 3) { firstP = t; break; }
  }
  const fpWords = firstP ? firstP.split(/\s+/).length : 0;
  const fpPts = fpWords >= 8 && fpWords <= 40 ? 2 : firstP ? 1 : 0;
  addCheck("content_quality", "Front-loaded direct answer in opening paragraph", fpPts, 2,
    firstP ? `Opening paragraph is ${fpWords} words` : "No clear opening paragraph found");
  cqCat += fpPts;

  const qHeadings = headingEls
    .map((el) => $(el).text().trim())
    .filter((t) => t.includes("?") || QUESTION_START_RE.test(t));
  const qPts = qHeadings.length ? 1 : 0;
  addCheck("content_quality", "Question-shaped headings (pattern-match user queries)", qPts, 1,
    qHeadings.length ? `${qHeadings.length} question-shaped heading(s): e.g. "${qHeadings[0]}"` : "No question-shaped headings found");
  cqCat += qPts;

  const statsMatches = bodyText.match(new RegExp(STAT_RE.source, "gi")) || [];
  const statsPts = statsMatches.length >= 2 ? 2 : statsMatches.length ? 1 : 0;
  addCheck("content_quality", "Concrete statistics / units in body", statsPts, 2,
    statsMatches.length ? `${statsMatches.length} stat-like mentions found` : "No specific stats found");
  cqCat += statsPts;

  const quoteCount = $("blockquote, q").length;
  const quotePts = quoteCount ? 1 : 0;
  addCheck("content_quality", "Quotations or blockquotes", quotePts, 1,
    quoteCount ? `${quoteCount} quotation element(s) found` : "No <blockquote> or <q> citations");
  cqCat += quotePts;

  result.categories.content_quality = cqCat;

  finish(result);
  result.fetch_seconds = round1((Date.now() - started) / 1000);
  result.size_kb = round1(sizeKb);
  result.status_code = resp.status;
  return result;
}

function finish(result) {
  const raw = Object.values(result.categories).reduce((a, b) => a + b, 0);
  result.raw_points = round1(raw);
  const score = Math.round((raw / result.max_points) * 100);
  result.score = score;
  result.grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
}

exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const url = params.url;
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (!url) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Missing url parameter" }) };
  }
  try {
    const result = await audit(url);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: String(e && e.message ? e.message : e) }) };
  }
};

