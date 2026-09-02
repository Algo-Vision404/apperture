// interview-context.js
// Builds context-aware, category-specific system prompt blocks for every
// direction an interview can take. Reads the live transcript to detect which
// category is in play and injects only the fields that are relevant.

// ── Question category detection ───────────────────────────────────────────────
const CATEGORY_PATTERNS = {
  behavioral: [
    /tell me about a time/i, /give me an example/i, /describe a situation/i,
    /when you (had|have|faced|dealt|worked|led|managed|failed|struggled)/i,
    /biggest (challenge|achievement|failure|mistake|success)/i,
    /how did you handle/i, /walk me through a time/i, /have you ever/i,
    /conflict with/i, /difficult (coworker|colleague|manager|teammate)/i,
    /under pressure/i, /tight deadline/i, /disagree(d)? with/i,
    /took initiative/i, /learned (quickly|fast|new)/i, /gave feedback/i,
    /leadership (without|experience)/i, /proud of/i,
    /most (challenging|difficult|proud|rewarding)/i,
    /example of (when|a time|how)/i,
    /situation (where|when|in which)/i,
  ],
  motivation: [
    /why (do you want|are you interested|this company|this role|us|here)/i,
    /why (are you leaving|did you leave|move on)/i,
    /what (attracted|draws|interests|excites|appeals) (you|to)/i,
    /where do you see yourself/i, /5 years/i, /career goals/i,
    /ideal (role|company|environment|manager|team)/i,
    /what (kind of|type of) (work|manager|team)/i,
    /motivates you/i, /passionate about/i,
    /why (are you|looking for) (a new|new|this)/i,
    /why should we hire/i,
    /what (do you|would you) bring/i,
    /long.term (goal|plan|career)/i,
    /looking for (in|from) (your next|a new|this)/i,
    /new opportunity/i,
  ],
  situational: [
    /what would you do if/i, /how would you (handle|approach|deal with)/i,
    /imagine you/i, /hypothetically/i, /if you (joined|started|were)/i,
    /how would you prioritize/i, /production (outage|incident|down)/i,
    /codebase (is a mess|legacy|technical debt)/i,
    /disagree with (your manager|a decision)/i,
    /walked into/i, /first (30|60|90) days/i,
  ],
  experience: [
    /tell me about your (experience|background|role|work|time) (at|in|with|on)/i,
    /walk me through your (resume|résumé|cv|background|experience|role|career|most recent)/i,
    /walk me through (your|the) (role|position|work|project|resume|résumé|cv)/i,
    /what (were you responsible|did you do|was your role)/i,
    /what (have you|did you) (built|worked on|done|shipped)/i,
    /biggest (project|achievement) (at|there|in your)/i,
    /tech stack/i, /day.to.day/i, /what did you build/i,
    /tell me more about/i, /elaborate on/i,
    /tell me about yourself/i,
    /tell me about your (current|previous|last|recent) (role|job|position|company)/i,
    /tell me about your time at/i,
    /what have you been working on/i,
    /walk me through what you('ve)? (done|built|worked on)/i,
    /can you (elaborate|expand) on/i,
    /your (most recent|last|current|previous) (role|job|position|company|internship)/i,
    /from your (resume|résumé|cv)/i,
    /on your (resume|résumé|cv)/i,
    /according to your (resume|résumé|cv)/i,
    /from my (resume|résumé|cv)/i,
    /on my (resume|résumé|cv)/i,
    /according to my (resume|résumé|cv)/i,
    /(resume|résumé|cv)\b/i,
    /(companies|roles|jobs|positions|internships).{0,48}(on|in|from).{0,16}(my|the|your).{0,8}(resume|résumé|cv)/i,
    /what (companies|roles|jobs|positions|internships)\b/i,
    /your (skills|education|projects|internship|internships)/i,
    /my (skills|education|projects|internship|internships|experience|background)/i,
    /where (did|have) you (work|worked|intern)/i,
    /what (company|companies|roles?) (have you|did you)/i,
  ],
  compensation: [
    /salary (expectation|requirement|range)/i, /compensation/i,
    /how much (are you|do you) (making|expect|want)/i,
    /when can you start/i, /notice period/i, /start date/i,
    /other (offer|interview|option)/i, /interviewing elsewhere/i,
  ],
  closing: [
    /do you have (any )?questions/i, /questions for us/i, /questions for me/i,
    /anything (you'?d? like to|you want to) ask/i,
    /we have (a few minutes|some time) (left|for questions)/i,
  ],
  technical: [
    /system design/i, /design (a|an|the) (system|service|api|database|url|feed|chat|cache|queue)/i,
    /explain (how|what|why|the difference|the concept)/i,
    /tradeoff/i, /trade.off/i,
    /sql vs nosql/i, /difference between/i,
    /what is .{2,40}\?/i,
    /how does .{2,40} work/i,
    /how would you design/i,
    /complexity/i, /algorithm/i, /data structure/i,
    /scale (this|to|it|a)/i, /architecture/i,
    /when (would you use|should you use|to use)/i,
    /pros and cons/i, /advantages (of|and disadvantages)/i,
    /implement (a|an|the)/i, /how (is|are|do|does|would)/i,
  ],
};

function detectCategory(transcript, extraText) {
  // Live interview: only the interviewer's ("Them") turns define the category.
  // Ask-box text is optional extra haystack so typed résumé questions still classify.
  const recentThem = (transcript || [])
    .filter(t => t.channel === 'them')
    .slice(-5)
    .map(t => t.text)
    .join(' ');
  const ask = typeof extraText === 'string' ? extraText.trim() : '';
  const haystack = [recentThem, ask].filter(Boolean).join('\n');
  if (!haystack) return 'general';

  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (patterns.some(re => re.test(haystack))) return category;
  }
  return 'general';
}

// ── Resume parser (carried over from resume-context.js) ───────────────────────
const SECTION_PATTERNS = [
  { key: 'name',       re: null, label: null },
  { key: 'summary',    re: /(?:summary|objective|profile|about)[^\n]*\n([\s\S]{20,400}?)(?=\n[A-Z]|\n\n[A-Z]|$)/i,      label: 'Summary' },
  { key: 'experience', re: /(?:experience|work history|employment)[^\n]*\n([\s\S]{20,1800}?)(?=\n(?:education|skills|projects|certif|awards|$))/i, label: 'Experience' },
  { key: 'skills',     re: /(?:skills?|technical skills?|competencies|tech stack)[^\n]*\n([\s\S]{10,600}?)(?=\n(?:experience|education|projects|certif|awards|work|$))/i, label: 'Skills' },
  { key: 'education',  re: /(?:education|academic)[^\n]*\n([\s\S]{10,400}?)(?=\n(?:experience|skills|projects|certif|awards|work|$))/i, label: 'Education' },
  { key: 'projects',   re: /(?:projects?|portfolio)[^\n]*\n([\s\S]{10,800}?)(?=\n(?:experience|education|skills|certif|awards|work|$))/i, label: 'Projects' },
];

function parseResume(text) {
  if (!text || !text.trim()) return null;
  const clean = text.trim();
  const sections = {};
  const firstLine = clean.split('\n').find(l => l.trim().length > 1 && l.trim().length < 80);
  if (firstLine) sections.name = firstLine.trim();
  for (const { key, re } of SECTION_PATTERNS) {
    if (!re) continue;
    const m = re.exec(clean);
    if (m && m[1]) sections[key] = m[1].trim().replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  }
  return { sections, raw: clean, parsed: Object.keys(sections).length > 1 };
}

function clip(text, limit) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return text.slice(0, limit).trimEnd() + '…';
}

// ── Context builders by category ──────────────────────────────────────────────

function buildResumeBlock(resumeText, limit = 2400) {
  if (!resumeText || !resumeText.trim()) return '';
  // Prefer the full raw résumé. Section regexes often mis-slice real PDF imports
  // (e.g. grabbing a skills fragment as "Experience"), which starves the model.
  return clip(String(resumeText).trim().replace(/\n{3,}/g, '\n\n'), limit);
}

function buildJDBlock(jd, limit = 600) {
  if (!jd || !jd.trim()) return '';
  return 'Target Role / Job Description:\n' + clip(jd.trim().replace(/\s+/g, ' '), limit);
}

const RESUME_GROUNDING_RULES =
  'CRITICAL — Résumé mode is ON.\n' +
  'The FULL RÉSUMÉ TEXT below is the only source of truth for the candidate\'s background.\n' +
  'For ANY question about experience, roles, companies, skills, education, projects, tools, dates, or "tell me about yourself":\n' +
  '• Answer from the résumé — name companies, titles, dates, tools, and outcomes that appear there.\n' +
  '• Speak in first person as the candidate (I / my), ready to say out loud.\n' +
  '• Prefer concrete facts over generic advice. If the résumé has the detail, use it.\n' +
  '• Do NOT invent employers, titles, dates, metrics, or skills that are not in the résumé.\n' +
  '• If a detail is missing, say the résumé does not include it — then answer as well as you can from what is there.\n' +
  '• Even short questions like "what did you do there?" or "your skills?" must be answered from this résumé.';

/**
 * buildInterviewContext(settings, mode, transcript, userText?)
 * Returns a system-prompt string with only the context fields relevant to
 * the detected interview category. Returns null for leetcode mode.
 */
function buildInterviewContext(settings, mode, transcript, userText) {
  // Coding problems never need personal context
  if (mode === 'leetcode') return null;

  const category = detectCategory(transcript || [], userText);
  const useResume = settings.useResume !== false;

  const resume    = settings.resumeText || '';
  const jd        = settings.jobDescription || '';
  const stories   = settings.starStories || '';
  const whyCo     = settings.whyCompany || '';
  const whyLeave  = settings.whyLeaving || '';
  const workStyle = settings.workStyle || '';
  const salary    = settings.salaryTarget || '';
  const questions = settings.questionsToAsk || '';

  const hasResume  = resume.trim().length > 0;
  const hasStories = stories.trim().length > 0;
  const hasJD      = jd.trim().length > 0;

  const blocks = [];

  // Résumé grounding — only when the Resume option is on and text is loaded.
  // Keep a large budget for experience/behavioral asks; trim hard for
  // technical/general questions so the model isn't drowning in unused context
  // (large prompts are a common cause of slow first tokens).
  if (useResume && hasResume) {
    const resumeLimit =
      category === 'experience' || category === 'behavioral' || category === 'motivation' || category === 'situational'
        ? 9000
        : category === 'technical'
          ? 1800
          : category === 'compensation' || category === 'closing'
            ? 600
            : 2200; // general / unknown
    const rb = buildResumeBlock(resume, resumeLimit);
    if (rb) {
      blocks.push(
        '=== Résumé grounding (ON) ===\n' +
        RESUME_GROUNDING_RULES +
        '\n\n--- FULL RÉSUMÉ TEXT ---\n' + rb + '\n--- END RÉSUMÉ ---'
      );
    }
  }

  // Job description — always include when available
  if (hasJD) {
    blocks.push(buildJDBlock(jd, category === 'technical' ? 300 : 600));
  }

  // Category-specific injections
  switch (category) {

    case 'behavioral':
      if (hasStories) {
        blocks.push(
          '=== Your STAR Stories (use these for behavioral questions) ===\n' +
          clip(stories.trim(), 2000) + '\n' +
          'IMPORTANT: When answering behavioral questions, use these real stories. ' +
          'Structure your answer: Situation → Task → Action → Result. ' +
          'Be specific, use numbers/metrics when available, keep it under 2 minutes spoken.'
        );
      } else {
        blocks.push(
          '(No STAR stories provided — construct a plausible story from the candidate\'s experience above. ' +
          'Be specific and grounded, avoid generic statements.)'
        );
      }
      if (workStyle) blocks.push('Work Style / Values:\n' + clip(workStyle, 400));
      break;

    case 'motivation':
      if (whyCo)    blocks.push('Why This Company:\n' + clip(whyCo, 500));
      if (whyLeave) blocks.push('Why Leaving Current Role:\n' + clip(whyLeave, 300));
      if (workStyle) blocks.push('Ideal Work Environment / Values:\n' + clip(workStyle, 400));
      break;

    case 'situational':
      if (workStyle) blocks.push('Decision-Making Style / Values:\n' + clip(workStyle, 500));
      if (hasStories) blocks.push('Relevant Past Experience:\n' + clip(stories, 800));
      break;

    case 'experience':
      // Already have full resume — no extra blocks needed
      if (hasStories) blocks.push('Key Stories / Highlights:\n' + clip(stories, 1000));
      break;

    case 'compensation':
      if (salary) blocks.push('Salary Target:\n' + salary);
      break;

    case 'closing':
      if (questions) {
        blocks.push(
          'Questions to Ask Interviewer:\n' + clip(questions, 600) + '\n' +
          'Pick 2–3 of these that fit what was discussed. Do not pivot to compensation unless they ask.'
        );
      } else {
        blocks.push(
          'Suggest 2–3 sharp questions about the role, team, or success criteria. Avoid generic “culture” questions.'
        );
      }
      break;

    case 'technical':
      // Resume skills section is most relevant here — already included above
      break;

    case 'general':
    default:
      if (hasStories) blocks.push('Key Experience Highlights:\n' + clip(stories, 600));
      if (workStyle)  blocks.push('Work Style:\n' + clip(workStyle, 300));
      break;
  }

  if (!blocks.length) return null;

  const tailorNote = hasJD
    ? '\nTailor every answer to highlight fit with the target role above.'
    : '';

  return blocks.join('\n\n') + tailorNote;
}

// ── Legacy compat ─────────────────────────────────────────────────────────────
function buildResumeContext(resumeText, jobDescription, mode) {
  if (!resumeText || !String(resumeText).trim()) return null;
  if (typeof jobDescription === 'number') {
    const cleaned = String(resumeText).trim().replace(/\s+/g, ' ');
    const limit = jobDescription || 1200;
    const clipped = cleaned.length > limit ? cleaned.slice(0, limit).trimEnd() + '…' : cleaned;
    return ['Candidate resume context:', clipped, 'Use this resume information when answering questions about the candidate.'].join('\n');
  }
  // Lightweight: no transcript available, just wrap resume+JD
  const rb = buildResumeBlock(resumeText, 1800);
  const jb = buildJDBlock(jobDescription || '', 600);
  const parts = [];
  if (rb) parts.push('=== Your Background ===\n' + rb);
  if (jb) parts.push(jb);
  if (!parts.length) return null;
  return parts.join('\n\n');
}

module.exports = { buildInterviewContext, buildResumeContext, detectCategory, parseResume };
