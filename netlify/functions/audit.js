/**
 * Business AEO Audit - Netlify Function
 * Grades a business website on how ready it is to be crawled, understood and
 * cited by AI answer engines (ChatGPT, Claude, Perplexity, Google AI Overviews).
 *
 * Same 114-raw-point rubric as the local Flask version, ported to Node + cheerio
 * so it can run as a Netlify serverless function. Every check that isn't full
 * marks includes a "fix" field with a specific, actionable recommendation.
 */
const cheerio = require("cheerio");

const UA = "Mozilla/5.0 (compatible; AEOAuditBot/1.0; +https://example.com/bot)";
const AI_BOTS = ["ChatGPT-User", "OAI-SearchBot", "PerplexityBot", "Claude-User", "ClaudeBot", "Google-Extended"];
const LANDMARKS = ["header", "nav", "main", "article", "section", "footer"];
const QUESTION_START_RE = /^\s*(who|what|why|how|when|where|which|can|do|does|is|are)\b/i;
const STAT_RE = /\b\d[\d,]*\.?\d*\s?(%|percent|years?|homes?|days?|dollars?|\$|sq\.?\s?ft|hours?|clients?|deals?|properties)\b/i;

const MAX_POINTS = { fetchability: 43, seo: 21, semantic: 13, answer_engine: 31, content_quality: 6, local_geo: 12 };
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

  const addCheck = (category, name, points, max, detail, fix) =>
    result.checks.push({ category, name, points: round1(points), max, detail, fix: points < max ? fix : null });

  const httpsOk = url.startsWith("https://");

  let resp;
  try {
    resp = await fetchWithTimeout(url);
  } catch (e) {
    addCheck("fetchability", "Reachable without bot blocking", 0, 18, "Request failed / timed out",
      "Check that the site is up and not blocking automated requests (Cloudflare/WAF bot challenges, IP blocks). Try fetching the URL from a server outside your own network to confirm it's reachable.");
    addCheck("fetchability", "Served over HTTPS", httpsOk ? 4 : 0, 4, httpsOk ? "URL uses HTTPS" : "URL does not use HTTPS",
      "Enable a free SSL certificate through your host or a CDN like Cloudflare, and redirect all HTTP traffic to HTTPS.");
    addCheck("fetchability", "Reasonable page size (<2.5MB)", 0, 3, "N/A - fetch failed", null);
    addCheck("fetchability", "robots.txt allows AI search crawlers", 0, 10, "Could not verify - fetch failed", null);
    addCheck("fetchability", "Content rendered server-side (visible without JS)", 0, 8, "N/A - fetch failed", null);
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
    `HTTP ${resp.status}` + (statusOk ? " - no bot challenge detected" : " - blocked/error"),
    "Remove or relax bot-blocking rules (Cloudflare/WAF \"I'm under attack\" mode, aggressive rate limits) so the page returns a normal 200 response to crawlers, not a challenge page.");
  fetchCat += reachablePts;

  const httpsPts = httpsOk ? 4 : 0;
  addCheck("fetchability", "Served over HTTPS", httpsPts, 4, httpsOk ? "URL uses HTTPS" : "URL does not use HTTPS",
    "Enable a free SSL certificate through your host or a CDN like Cloudflare, and redirect all HTTP traffic to HTTPS.");
  fetchCat += httpsPts;

  const sizePts = sizeKb < 2500 ? 3 : sizeKb < 5000 ? 1 : 0;
  addCheck("fetchability", "Reasonable page size (<2.5MB)", sizePts, 3, `${sizeKb.toFixed(1)} KB downloaded`,
    "Compress images (WebP, proper sizing), minify CSS/JS, and remove unused embeds or scripts to bring the page under 2.5MB.");
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
  addCheck("fetchability", "robots.txt allows AI search crawlers", robotsPts, 10, robotsDetail,
    "Add explicit \"Allow: /\" rules for ChatGPT-User, OAI-SearchBot, PerplexityBot, ClaudeBot, and Google-Extended in your robots.txt file so AI crawlers aren't blocked.");
  fetchCat += robotsPts;

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(" ").length : 0;
  const ssrPts = wordCount >= 150 ? 8 : wordCount >= 50 ? 4 : 0;
  addCheck("fetchability", "Content rendered server-side (visible without JS)", ssrPts, 8,
    `Body contains ${wordCount} words of server-rendered text.`,
    "Make sure your main content is present in the initial HTML response rather than injected only after JavaScript runs. Use server-side rendering, static generation, or pre-rendering for key pages.");
  fetchCat += ssrPts;

  result.categories.fetchability = fetchCat;

  // ---- Core SEO ----
  let seoCat = 0;
  const titleTag = ($("title").first().text() || "").trim();
  const tlen = titleTag.length;
  const titlePts = tlen >= 25 && tlen <= 65 ? 4 : (tlen >= 10 && tlen < 25) || (tlen > 65 && tlen <= 80) ? 2 : 0;
  addCheck("seo", "Title tag (25-65 characters)", titlePts, 4, `Title is ${tlen} characters: "${titleTag}"`,
    "Rewrite the <title> tag to 25-65 characters, leading with your main service and location, e.g. \"We Buy Houses Fast for Cash in [City] | [Business Name]\".");
  seoCat += titlePts;

  const metaDesc = ($('meta[name="description"]').attr("content") || "").trim();
  const dlen = metaDesc.length;
  const descPts = dlen >= 80 && dlen <= 175 ? 4 : metaDesc ? 2 : 0;
  addCheck("seo", "Meta description (80-175 characters)", descPts, 4,
    metaDesc ? `${dlen} characters` : 'Missing <meta name="description">',
    "Add a <meta name=\"description\"> tag of 80-175 characters that clearly states what you do, who you serve, and your service area.");
  seoCat += descPts;

  const canonicalHref = $('link[rel="canonical"]').attr("href");
  const canonicalPts = canonicalHref ? 3 : 0;
  addCheck("seo", "Canonical URL declared", canonicalPts, 3,
    canonicalHref ? `Canonical: ${canonicalHref}` : "No canonical tag found",
    "Add a <link rel=\"canonical\" href=\"...\"> tag to each page pointing to its preferred URL.");
  seoCat += canonicalPts;

  const ogTitle = $('meta[property="og:title"]').attr("content");
  const ogDesc = $('meta[property="og:description"]').attr("content");
  const ogImage = $('meta[property="og:image"]').attr("content");
  const ogFound = [ogTitle, ogDesc, ogImage].filter(Boolean).length;
  const ogPts = round1((3 * ogFound) / 3);
  const ogMissing = [!ogTitle && "og:title", !ogDesc && "og:description", !ogImage && "og:image"].filter(Boolean);
  addCheck("seo", "OpenGraph tags (title, description, image)", ogPts, 3, `${ogFound}/3 OpenGraph tags present`,
    ogMissing.length ? `Add the missing tag(s): ${ogMissing.join(", ")}.` : null);
  seoCat += ogPts;

  const twCard = $('meta[name="twitter:card"]').attr("content");
  const twPts = twCard ? 2 : 0;
  addCheck("seo", "Twitter Card tag", twPts, 2, twCard ? `twitter:card = ${twCard}` : "No twitter:card tag",
    "Add <meta name=\"twitter:card\" content=\"summary_large_image\"> to your page head.");
  seoCat += twPts;

  const lang = $("html").attr("lang");
  const langPts = lang ? 1 : 0;
  addCheck("seo", "<html lang> attribute", langPts, 1, lang ? `lang="${lang}"` : "No lang attribute",
    "Add lang=\"en-US\" (or your appropriate locale) to the opening <html> tag.");
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
    sitemapFound ? `Found sitemap at ${sitemapUrl} with ${sitemapUrlsCount} URLs` : "No sitemap found",
    !sitemapFound
      ? "Generate an XML sitemap listing every indexable page on your site."
      : (!sitemapInRobots ? "Reference your sitemap in robots.txt with a line like \"Sitemap: https://yoursite.com/sitemap.xml\"." : null));
  seoCat += sitemapPts;

  result.categories.seo = seoCat;

  // ---- Semantic HTML ----
  let semCat = 0;
  const h1Count = $("h1").length;
  const h1Pts = h1Count === 1 ? 3 : h1Count > 0 ? 1 : 0;
  addCheck("semantic", "Exactly one <h1>", h1Pts, 3, `Found ${h1Count} <h1> elements`,
    h1Count === 0
      ? "Add exactly one <h1> containing your page's main headline."
      : `Keep only one <h1> per page (your main headline) and change the other ${h1Count - 1} to <h2> or <h3>.`);
  semCat += h1Pts;

  const headingEls = $("h1, h2, h3, h4, h5, h6").toArray();
  const levels = headingEls.map((el) => parseInt(el.tagName.slice(1), 10));
  let skipped = false;
  for (let i = 0; i < levels.length - 1; i++) {
    if (levels[i + 1] - levels[i] > 1) { skipped = true; break; }
  }
  const hierPts = skipped ? 1 : 3;
  addCheck("semantic", "Heading hierarchy (no skipped levels)", hierPts, 3,
    skipped ? "Heading levels skip (e.g. <h1> to <h3>)" : "No skipped heading levels",
    skipped ? "Reorder headings so levels step down one at a time (H1 -> H2 -> H3), never skipping a level." : null);
  semCat += hierPts;

  const foundLandmarks = LANDMARKS.filter((tag) => $(tag).length > 0 || $(`[role="${tag}"]`).length > 0);
  const missingLandmarks = LANDMARKS.filter((tag) => !foundLandmarks.includes(tag));
  const landmarkPts = round1((4 * foundLandmarks.length) / LANDMARKS.length);
  addCheck("semantic", "Semantic HTML landmarks", landmarkPts, 4,
    foundLandmarks.length ? `Landmarks present: ${foundLandmarks.join(", ")}` : "No landmarks found",
    missingLandmarks.length ? `Wrap the relevant sections in the missing semantic tag(s): ${missingLandmarks.join(", ")}.` : null);
  semCat += landmarkPts;

  const imgs = $("img").toArray();
  const imgsWithAlt = imgs.filter((i) => ($(i).attr("alt") || "").trim().length > 0);
  const altPts = imgs.length === 0 ? 3 : round1((3 * imgsWithAlt.length) / imgs.length);
  addCheck("semantic", "Image alt text coverage", altPts, 3,
    imgs.length ? `${imgsWithAlt.length}/${imgs.length} images have an alt attribute` : "No images found (n/a, full credit)",
    imgs.length && imgsWithAlt.length < imgs.length
      ? `Add a descriptive alt attribute to the ${imgs.length - imgsWithAlt.length} image(s) missing one.`
      : null);
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
    llmsFound ? "/llms.txt found" : "/llms.txt not found (404 or unreachable)",
    "Add a plain-text /llms.txt file at your site root summarizing who you are, what you offer, your service area, and links to your key pages, using the emerging llms.txt convention.");
  aeCat += llmsFound ? 5 : 0;

  let llmsFullFound = false;
  try {
    const r = await fetchWithTimeout(`${parsedUrl.origin}/llms-full.txt`, 8000);
    llmsFullFound = r.status === 200;
  } catch (e) {}
  addCheck("answer_engine", "/llms-full.txt (bonus full-content dump)", llmsFullFound ? 1 : 0, 1,
    llmsFullFound ? "/llms-full.txt found" : "/llms-full.txt not present",
    "Add a /llms-full.txt with your full site content in plain text or markdown, for AI crawlers that read it directly.");
  aeCat += llmsFullFound ? 1 : 0;

  const jsonLdCount = $('script[type="application/ld+json"]').length;
  const jsonLdPts = jsonLdCount > 0 ? 6 : 0;
  addCheck("answer_engine", "JSON-LD structured data", jsonLdPts, 6,
    jsonLdCount ? `${jsonLdCount} JSON-LD block(s) found` : "No JSON-LD structured data",
    "Add a JSON-LD <script type=\"application/ld+json\"> block using schema.org LocalBusiness or Organization markup with your name, address, phone, and sameAs links to your social profiles.");
  aeCat += jsonLdPts;

  const sameAs = /sameas/i.test(html);
  const byline = $('[rel="author"]').length > 0 || /class="[^"]*author[^"]*"/i.test(html);
  const authorityPts = sameAs && byline ? 3 : sameAs || byline ? 1.5 : 0;
  addCheck("answer_engine", "Author / Organization authority signals", authorityPts, 3,
    authorityPts ? "Found author/sameAs signals" : "No author byline or Organization sameAs found",
    "Add \"sameAs\" links in your structured data pointing to your verified Google Business Profile, LinkedIn, and Facebook pages, and/or an author byline on content pages.");
  aeCat += authorityPts;

  const dateModified = /datemodified/i.test(html) || /datepublished/i.test(html);
  const freshPts = dateModified ? 2 : 1;
  addCheck("answer_engine", "Content freshness (dateModified within 12 months)", freshPts, 2,
    dateModified ? "dateModified found in structured data" : "No dateModified in structured data (acceptable for evergreen pages)",
    dateModified ? null : "If this page's content changes over time, add a dateModified field to its structured data and keep it current.");
  aeCat += freshPts;

  const hasBlog = /\/(blog|news|articles)\b/i.test(html);
  const depthPts = Math.min(4,
    (sitemapUrlsCount >= 1 ? 1 : 0) +
    (sitemapUrlsCount >= 10 ? 2 : sitemapUrlsCount >= 3 ? 1 : 0) +
    (hasBlog ? 1 : 0));
  addCheck("answer_engine", "Content depth (sitemap URL count, blog, recency)", depthPts, 4,
    `${sitemapUrlsCount} URLs in sitemap.` + (hasBlog ? " Blog/news section detected." : ""),
    depthPts < 4 ? "Add more indexable pages (service pages, an About page, FAQ, or a blog/news section) and make sure they're all listed in your sitemap." : null);
  aeCat += depthPts;

  const $clone = cheerio.load(html);
  $clone("script, style, nav, header, footer, noscript").remove();
  const readableText = $clone("main, article").first().text().trim() ||
    $clone("body").text().replace(/\s+/g, " ").trim();
  const rChars = readableText.length;
  const readPts = rChars > 1000 ? 5 : rChars > 300 ? 3 : rChars > 0 ? 1 : 0;
  addCheck("answer_engine", "Mozilla Readability extraction", readPts, 5,
    rChars ? `Extracted ${rChars} chars of readable long-form content` : "Could not extract readable content",
    rChars < 1000 ? "Add more substantive long-form copy explaining your process, service area, and what makes you different — aim for 500+ words of real explanatory text, not just short taglines." : null);
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
  addCheck("answer_engine", "Contact info (phone, address, hours, service area)", napPts, 5, napDetail,
    missing.length ? `Add the missing element(s) to your page (e.g. in the footer): ${missing.join(", ")}.` : null);
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
    firstP ? `Opening paragraph is ${fpWords} words` : "No clear opening paragraph found",
    fpPts < 2 ? "Rewrite the opening paragraph to directly answer \"what do you do and for whom\" in 8-40 words, before any other copy." : null);
  cqCat += fpPts;

  const qHeadings = headingEls
    .map((el) => $(el).text().trim())
    .filter((t) => t.includes("?") || QUESTION_START_RE.test(t));
  const qPts = qHeadings.length ? 1 : 0;
  addCheck("content_quality", "Question-shaped headings (pattern-match user queries)", qPts, 1,
    qHeadings.length ? `${qHeadings.length} question-shaped heading(s): e.g. "${qHeadings[0]}"` : "No question-shaped headings found",
    qPts === 0 ? "Add a few headings phrased as real customer questions, e.g. \"How Fast Can You Buy My House?\" or \"Do You Buy Houses In Any Condition?\"." : null);
  cqCat += qPts;

  const statsMatches = bodyText.match(new RegExp(STAT_RE.source, "gi")) || [];
  const statsPts = statsMatches.length >= 2 ? 2 : statsMatches.length ? 1 : 0;
  addCheck("content_quality", "Concrete statistics / units in body", statsPts, 2,
    statsMatches.length ? `${statsMatches.length} stat-like mentions found` : "No specific stats found",
    statsPts < 2 ? "Include concrete numbers — years in business, homes bought, average days to close, service area size — instead of only general claims." : null);
  cqCat += statsPts;

  const quoteCount = $("blockquote, q").length;
  const quotePts = quoteCount ? 1 : 0;
  addCheck("content_quality", "Quotations or blockquotes", quotePts, 1,
    quoteCount ? `${quoteCount} quotation element(s) found` : "No <blockquote> or <q> citations",
    quotePts === 0 ? "Add at least one client testimonial wrapped in a <blockquote> element." : null);
  cqCat += quotePts;

  result.categories.content_quality = cqCat;

  // ---- Local & Geo Signals ----
  let geoCat = 0;
  let hasLocalBusinessSchema = false;
  let jsonLdPhone = null;
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const items = Array.isArray(data) ? data : (data["@graph"] ? data["@graph"] : [data]);
      for (const item of items) {
        const type = item["@type"];
        const typeStr = Array.isArray(type) ? type.join(",") : (type || "");
        if (/localbusiness|realestateagent|homeandconstructionbusiness|store|organization/i.test(typeStr)) {
          if (item.address && item.geo && item.geo.latitude && item.geo.longitude) {
            hasLocalBusinessSchema = true;
          }
          if (item.telephone) jsonLdPhone = item.telephone;
        }
      }
    } catch (e) { /* invalid or non-object JSON-LD, ignore */ }
  });

  const geoSchemaPts = hasLocalBusinessSchema ? 4 : 0;
  addCheck("local_geo", "LocalBusiness schema with geo-coordinates", geoSchemaPts, 4,
    hasLocalBusinessSchema ? "Found LocalBusiness/Organization schema with address and geo coordinates" : "No LocalBusiness schema with address + geo coordinates found",
    hasLocalBusinessSchema ? null : "Add \"address\" and \"geo\" (latitude/longitude) fields to your JSON-LD LocalBusiness schema so AI and map services can pinpoint your service area.");
  geoCat += geoSchemaPts;

  const cityStateMatches = bodyText.match(/\b[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?,\s?[A-Z]{2}\b/g) || [];
  const distinctCities = [...new Set(cityStateMatches.map((s) => s.toLowerCase()))];
  const serviceAreaPts = distinctCities.length >= 3 ? 3 : distinctCities.length >= 1 ? 1.5 : 0;
  addCheck("local_geo", "Service-area specificity (named cities/towns)", serviceAreaPts, 3,
    distinctCities.length ? `${distinctCities.length} distinct city/state mention(s) found` : "No specific city/town service-area mentions found",
    serviceAreaPts < 3 ? "List the specific cities/towns you serve (e.g. \"Grand Rapids, MI, Wyoming, MI, Kentwood, MI\") instead of only a generic \"service area\" phrase." : null);
  geoCat += serviceAreaPts;

  const hasMap = /maps\.google\.com|google\.com\/maps|maps\/embed|maps\.googleapis/i.test(html);
  const mapPts = hasMap ? 2 : 0;
  addCheck("local_geo", "Embedded map", mapPts, 2,
    hasMap ? "Embedded Google Map detected" : "No embedded map found",
    hasMap ? null : "Embed a Google Map showing your location or service area — it's a strong, easy local-relevance signal.");
  geoCat += mapPts;

  const bodyPhoneMatch = bodyText.match(/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/);
  const normalizePhone = (p) => (p || "").replace(/\D/g, "").slice(-10);
  let napPts2, napDetail2, napFix2;
  if (jsonLdPhone && bodyPhoneMatch) {
    const match = normalizePhone(jsonLdPhone) === normalizePhone(bodyPhoneMatch[0]);
    napPts2 = match ? 3 : 0;
    napDetail2 = match ? "Phone number in structured data matches the phone shown on the page" : `Mismatch: schema shows ${jsonLdPhone}, page shows ${bodyPhoneMatch[0]}`;
    napFix2 = match ? null : "Make sure the phone number in your JSON-LD structured data exactly matches the phone number shown on the page.";
  } else if (jsonLdPhone && !bodyPhoneMatch) {
    napPts2 = 1.5;
    napDetail2 = "Phone found in structured data but not visible on the page";
    napFix2 = "Display your phone number visibly on the page (e.g. in the header or footer), not just in structured data.";
  } else {
    napPts2 = 1.5;
    napDetail2 = "No phone number in structured data to verify against";
    napFix2 = "Add a \"telephone\" field to your JSON-LD structured data matching the phone number shown on the page.";
  }
  addCheck("local_geo", "NAP consistency (phone matches structured data)", napPts2, 3, napDetail2, napFix2);
  geoCat += napPts2;

  result.categories.local_geo = geoCat;

  finish(result);
  result.fetch_seconds = round1((Date.now() - started) / 1000);
  result.size_kb = round1(sizeKb);
  result.status_code = resp.status;
  return result;
}

function gradeOf(score) {
  return score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
}

const AEO_CATEGORY_KEYS = ["fetchability", "seo", "semantic", "answer_engine", "content_quality"];

function finish(result) {
  const raw = Object.values(result.categories).reduce((a, b) => a + b, 0);
  result.raw_points = round1(raw);
  const score = Math.round((raw / result.max_points) * 100);
  result.score = score;
  result.grade = gradeOf(score);

  const aeoMax = AEO_CATEGORY_KEYS.reduce((a, k) => a + MAX_POINTS[k], 0);
  const aeoRaw = AEO_CATEGORY_KEYS.reduce((a, k) => a + (result.categories[k] || 0), 0);
  result.aeo_max = aeoMax;
  result.aeo_raw = round1(aeoRaw);
  result.aeo_score = Math.round((aeoRaw / aeoMax) * 100);
  result.aeo_grade = gradeOf(result.aeo_score);
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
