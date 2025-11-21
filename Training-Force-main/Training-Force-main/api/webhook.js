//Version 1.8

// /api/webhook.js
// WhatsApp Cloud webhook: Training Force application flow + Required Documents.
//
// Changes in this version:
// • Block if employed === Yes (stop with message).
// • After "Done learnership = Yes" + SETA answer → ask previous qualification + when completed.
// • SARS doc is now COMPULSORY (no skip).
// • Block if SA ID age > 28 (18–28 window enforced on "over 28" per request).
// • Block if study_type === Full-Time (allow Part-Time only).
// • Removed "Chronic illness" from disability picklist.
// • If disability_early === "Yes", Proof of Disability doc is COMPULSORY.
// • Highest grade limited to Grade 10/11/12 only.
// • "Enter different #" asks for a single 10-digit number (no area code step).
// • **Use WhatsApp #** now captures immediately and jumps to Email.
// • Docs intro text adapts (SARS *, and Disability * when required).
// • New heads-up after submit: no re-uploads and no new apps on same number.
// • Old failure-only heads-up is commented out.
// • No "Back" logic (fully removed).

// ---------------------------------------------------------------------------
const stateMem = new Map();

const FLOW_URL =
  process.env.PA_FLOW_URL ||
  "https://defaultc85c16bf18244a90b7a43fa4a151bf.dc.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/dec0335b5d014e698aeb36e81295db1f/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=Py3ty56FmFb6xBwojL454kYb_rJawL6xXfVd72fsGZU";

const WAIT = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const lc = (x) => (x || "").toString().trim().toLowerCase();
const digits = (s) => (s || "").replace(/\D+/g, "");
const validPostal = (s) => /^\d{4}$/.test((s || "").trim());
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s || "").trim());
const replaceTo = (payload, to) => JSON.parse(JSON.stringify(payload).replaceAll("@FROM@", to));

// ---------- KV (Upstash REST) ----------
const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.KV_URL ||
  "";
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.KV_REST_API_READ_ONLY_TOKEN ||
  "";

async function kvGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return stateMem.get(key);
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!r.ok) return stateMem.get(key);
  const json = await r.json();
  try {
    return json.result ? JSON.parse(json.result) : undefined;
  } catch {
    return undefined;
  }
}
async function kvSet(key, value) {
  stateMem.set(key, value);
  if (!REDIS_URL || !REDIS_TOKEN) return;
  const v = JSON.stringify(value);
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(v)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  }).catch(() => {});
}
async function resetState(waId) {
  await kvSet(waId, { step: "idle", data: {}, docs: {}, last_msg_id: "", hist: [] });
}

// ---------- WhatsApp send ----------
async function waSend(pnid, to, payload) {
  const url = `https://graph.facebook.com/v22.0/${pnid}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(replaceTo(payload, to)),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("WA send failed", r.status, t);
  }
}

// ---------- Push to Power Automate ----------
async function pushToFlow({ whatsapp_id, data, docs }) {
  const tryOnce = async () => {
    const r = await fetch(FLOW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ whatsapp_id, data, docs }),
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) throw new Error(`PA ${r.status} ${text || ""}`.trim());
    try { return JSON.parse(text); } catch { return { ok: true }; }
  };
  try { return await tryOnce(); }
  catch { await WAIT(400); try { return await tryOnce(); } catch (e2) { console.error("pushToFlow failed:", e2?.message || e2); return { ok: false, error: String(e2) }; } }
}

// ---------- Helpers ----------
function raceTitle(id) {
  return (
    {
      race_black_african: "Black African",
      race_coloured: "Coloured",
      race_indian_asian: "Indian/Asian",
      race_white: "White",
    }[id] || id
  );
}
function provinceTitle(id) {
  return (
    {
      province_ec: "Eastern Cape",
      province_fs: "Free State",
      province_gp: "Gauteng",
      province_kzn: "KwaZulu-Natal",
      province_lp: "Limpopo",
      province_mp: "Mpumalanga",
      province_nw: "North West",
      province_nc: "Northern Cape",
      province_wc: "Western Cape",
    }[id] || id
  );
}
function extractMedia(msg) {
  if (msg?.type === "document" && msg.document?.id) {
    return {
      kind: "document",
      id: msg.document.id,
      mime_type: msg.document.mime_type || "",
      filename: msg.document.filename || "",
      sha256: msg.document.sha256 || "",
    };
  }
  if (msg?.type === "image" && msg.image?.id) {
    return {
      kind: "image",
      id: msg.image.id,
      mime_type: msg.image.mime_type || "",
      filename: msg.image.filename || "",
      sha256: msg.image.sha256 || "",
    };
  }
  return null;
}

// Age from SA ID
function parseDobFromSaId(id) {
  try {
    const yy = Number(id.slice(0, 2));
    const mm = Number(id.slice(2, 4));
    const dd = Number(id.slice(4, 6));
    const now = new Date();
    const curYY = now.getFullYear() % 100;
    const year = yy <= curYY ? 2000 + yy : 1900 + yy;
    const dob = new Date(year, mm - 1, dd);
    if (dob.getFullYear() !== year || dob.getMonth() !== mm - 1 || dob.getDate() !== dd) return null;
    return dob;
  } catch { return null; }
}
function ageFromDob(dob) {
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

// Block + end helper
async function blockAndEnd(pnid, from, msg) {
  await waSend(pnid, from, {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: `${msg}\n\nThank you for your interest.` },
  });
  const s = await getState(from);
  s.step = "done";
  await setState(from, s);
}

// ---------- sendPrompt (Back fully removed) ----------
async function sendPromptWithBack(pnid, from, key) {
  const p = prompts[key];
  if (!p) return;
  await waSend(pnid, from, p);
}

// ---------- Fixed intro & disability ----------
const intro = {
  messaging_product: "whatsapp",
  to: "@FROM@",
  type: "image",
  image: {
    link: "https://trainingforce.co.za/wp-content/uploads/2021/06/logomain2.png",
    caption:
      "Welcome to Training Force WhatsApp Recruitment Form. Applicants can also apply:\n" +
      "*Website:* https://www.trainingforce.co.za/individual-learners/\n" +
      "*Email:* Learnerapplications@trainingforce.co.za\n\nLet's get you started 😊",
  },
};
const whoCanApplyText = {
  messaging_product: "whatsapp",
  to: "@FROM@",
  type: "text",
  text: {
    body:
      "*WHO CAN APPLY:*\n" +
      "• Learnerships are for candidates aged *18–28 years* with *Grade 10 – Grade 12*.\n" +
      "• You must be a *South African citizen*.\n\n" +
      "💡 We *do not charge* for Learnership applications.",
  },
};
const disabilityYesNo = {
  messaging_product: "whatsapp",
  to: "@FROM@",
  type: "interactive",
  interactive: {
    type: "button",
    body: {
      text: "Do you have a *medically recognised disability?*\n👉 Reply with *Yes* or *No*, or tap a button below.",
    },
    action: {
      buttons: [
        { type: "reply", reply: { id: "disability_yes", title: "Yes" } },
        { type: "reply", reply: { id: "disability_no", title: "No" } },
      ],
    },
  },
};
const disabilityList = {
  messaging_product: "whatsapp",
  to: "@FROM@",
  type: "interactive",
  interactive: {
    type: "list",
    header: { type: "text", text: "Learnership Info" },
    body: { text: "*Select your disability type:*" },
    footer: { text: "Tap to choose an option" },
    action: {
      button: "Choose disability",
      sections: [
        {
          title: "Disability Type",
          rows: [
            { id: "disability_visual", title: "Visual impairment", description: "Blindness or low vision" },
            { id: "disability_hearing", title: "Hearing impairment", description: "Deaf or hard of hearing" },
            { id: "disability_physical", title: "Physical impairment", description: "Mobility/dexterity" },
            { id: "disability_intellectual", title: "Intellectual disability", description: "Cognitive limitations" },
            { id: "disability_learning", title: "Learning disability", description: "e.g., dyslexia" },
            { id: "disability_psychosocial", title: "Psychosocial", description: "Mental health condition" },
            // Removed "disability_chronic"
            { id: "disability_other", title: "Other", description: "Describe in the next message" },
          ],
        },
      ],
    },
  },
};
const describeDisability = {
  messaging_product: "whatsapp",
  to: "@FROM@",
  type: "text",
  text: { preview_url: false, body: "Describe your disability." },
};
const applyButton = {
  messaging_product: "whatsapp",
  to: "@FROM@",
  type: "interactive",
  interactive: {
    type: "button",
    body: { text: "👇 Click *Apply* to start your learnership application." },
    action: { buttons: [{ type: "reply", reply: { id: "apply_start", title: "Apply" } }] },
  },
};

// ---------- Prompts after Apply ----------
const prompts = {
  // Personal
  ask_first_name: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "Personal Details\n\n*First Name* — please enter your first name (e.g. Thabo)." },
  },
  ask_last_name: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "*Last Name* — please enter your surname (e.g. Mokoena)." },
  },
  ask_id: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: {
      preview_url: false,
      body:
        "*What is your South African ID number?*\n\n_Tips:_\n• 13 digits, numbers only\n• No spaces or dashes\n• Example: 9001010123087",
    },
  },

  // Race (LIST ONLY)
  ask_race: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Race" },
      body: { text: "*What is your race?* — select a value." },
      footer: { text: "Training Force" },
      action: {
        button: "Choose race",
        sections: [
          {
            title: "Options",
            rows: [
              { id: "race_black_african", title: "Black African" },
              { id: "race_coloured", title: "Coloured" },
              { id: "race_indian_asian", title: "Indian/Asian" },
              { id: "race_white", title: "White" },
            ],
          },
        ],
      },
    },
  },

  // Gender
  ask_gender: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "*What is your gender?* — select a value." },
      action: {
        buttons: [
          { type: "reply", reply: { id: "gender_male", title: "Male" } },
          { type: "reply", reply: { id: "gender_female", title: "Female" } },
        ],
      },
    },
  },

  // Contact (updated)
  ask_contact_intro: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text:
          "Contact details\n\nWe can use your WhatsApp number *as your contact number*.\nUse this number or enter a different one?",
      },
      action: {
        buttons: [
          { type: "reply", reply: { id: "use_wa_number", title: "Use WhatsApp #" } },
          { type: "reply", reply: { id: "enter_phone", title: "Enter different #" } },
        ],
      },
    },
  },
  ask_phone_full: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "*Enter your 10-digit cellphone number* (e.g. 0821234567)." },
  },

  ask_email: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "*What is your email address?* (e.g. name@example.com)" },
  },
  ask_street: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "Residential address\n\n*Street Address* — e.g. 13 Wellington Street" },
  },
  ask_city: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "*City* — e.g. Parktown" },
  },
  ask_province: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Select Province" },
      body: { text: "Please choose your province from the list below." },
      footer: { text: "Training Force" },
      action: {
        button: "Choose province",
        sections: [
          {
            title: "South African Provinces",
            rows: [
              { id: "province_ec", title: "Eastern Cape" },
              { id: "province_fs", title: "Free State" },
              { id: "province_gp", title: "Gauteng" },
              { id: "province_kzn", title: "KwaZulu-Natal" },
              { id: "province_lp", title: "Limpopo" },
              { id: "province_mp", title: "Mpumalanga" },
              { id: "province_nw", title: "North West" },
              { id: "province_nc", title: "Northern Cape" },
              { id: "province_wc", title: "Western Cape" },
            ],
          },
        ],
      },
    },
  },
  ask_postal: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "*Postal code* — 4 digits (e.g. 2193)" },
  },

  // Education & Employment
  ask_highest_grade: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Highest grade passed" },
      body: { text: "Select your highest grade passed." },
      action: {
        button: "Choose grade",
        sections: [
          {
            title: "Options",
            rows: [
              { id: "grade_10", title: "Grade 10" },
              { id: "grade_11", title: "Grade 11" },
              { id: "grade_12", title: "Grade 12" },
            ],
          },
        ],
      },
    },
  },
  ask_last_school: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "*Last school attended* — please enter the name." },
  },
  ask_done_learnership: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "*Have you done a learnership before?* — select a value." },
      action: {
        buttons: [
          { type: "reply", reply: { id: "learnership_yes", title: "Yes" } },
          { type: "reply", reply: { id: "learnership_no", title: "No" } },
        ],
      },
    },
  },
  ask_ceta: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "If yes: *Did you successfully complete the learnership with a SETA certificate?*" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "ceta_yes", title: "Yes" } },
          { type: "reply", reply: { id: "ceta_no", title: "No" } },
        ],
      },
    },
  },
  ask_prev_qualification: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "*What previous qualification did you complete?* (e.g. NC: XYZ Level 2)" },
  },
  ask_prev_when: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "*When was it completed?* (e.g. 2023-11)" },
  },

  ask_currently_studying: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "*Currently studying?* — select a value." },
      action: {
        buttons: [
          { type: "reply", reply: { id: "studying_yes", title: "Yes" } },
          { type: "reply", reply: { id: "studying_no", title: "No" } },
        ],
      },
    },
  },
  ask_study_type: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "If studying: *What is your study type?*" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "part_time", title: "Part-Time (online)" } },
          { type: "reply", reply: { id: "full_time", title: "Full-Time" } },
        ],
      },
    },
  },

  ask_employed: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "*Currently employed?* — select a value." },
      action: {
        buttons: [
          { type: "reply", reply: { id: "employ_yes", title: "Yes" } },
          { type: "reply", reply: { id: "employ_no", title: "No" } },
        ],
      },
    },
  },

  // Documents (SARS is compulsory now)
  ask_cv_upload: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "📎 *Updated CV* — please upload your CV now (PDF/Doc/Image)." },
  },
  ask_id_upload: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "📎 *Certified ID copy* — please upload now (PDF/Image)." },
  },
  ask_qual_upload: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "📎 *Highest qualification or latest school report* — please upload now (PDF/Image)." },
  },
  ask_sars_upload: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "📎 *SARS Tax Reference Letter* — please upload now (PDF/Image)." },
  },
  ask_bank_upload: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "📎 *Bank statement or official bank confirmation letter* — please upload now (PDF/Image)." },
  },

  // Disability doc
  ask_disability_doc_optional: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "📎 Proof Of Disability Document — optional. Upload now or skip?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "upload_disability_doc", title: "Upload now" } },
          { type: "reply", reply: { id: "skip_disability_doc", title: "Skip" } },
        ],
      },
    },
  },
  ask_disability_doc_upload: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "📎 *Proof Of Disability Document* — please upload now (PDF/Image)." },
  },

  // Submit
  ask_submit: {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "All set. Review the summary above.\nTap *Submit Application* to finish." },
      action: { buttons: [{ type: "reply", reply: { id: "submit_application", title: "Submit Application" } }] },
    },
  },
};

// Build a dynamic Docs Intro payload (SARS *; Disability * if required)
function buildDocsIntroPayload(s) {
  const needsDisabilityDoc = (s?.data?.disability_early || "") === "Yes";
  const text =
    "Required Documents\nTo be uploaded with your application\n\n" +
    "Please upload the following. Items marked * are required.\n" +
    "• Updated CV *\n" +
    "• Certified ID copy *\n" +
    "• Highest qualification or latest school report *\n" +
    "• SARS Tax Reference Letter *\n" +
    "• Bank statement or official bank confirmation letter *\n" +
    `• Proof Of Disability Document${needsDisabilityDoc ? " *" : " (optional)"}\n\n` +
    "Reply by uploading each document when asked.";
  return {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: text },
  };
}

// ---------- Order after Apply ----------
const order = [
  "ask_first_name",
  "ask_last_name",
  "ask_id",
  "ask_race",
  "ask_gender",
  "ask_contact_intro",
  "ask_phone_full",      // only used if user chooses different #
  "ask_email",
  "ask_street",
  "ask_city",
  "ask_province",
  "ask_postal",
  "ask_highest_grade",
  "ask_last_school",
  "ask_done_learnership",
  "ask_ceta",
  "ask_prev_qualification", // conditional branch
  "ask_prev_when",          // conditional branch
  "ask_currently_studying",
  "ask_study_type",
  "ask_employed",
  // Docs
  "ask_cv_upload",
  "ask_id_upload",
  "ask_qual_upload",
  "ask_sars_upload",            // compulsory now
  "ask_bank_upload",
  "ask_disability_doc_optional",// optional unless disability_early === "Yes"
  "ask_disability_doc_upload",  // may be jumped to if required
  "ask_submit",
];

// Map await_* → linear indices
const stepIndexMap = (() => {
  const m = { idle: -1, await_apply: 0, await_disability: 0, await_disability_type: 0, await_disability_other_text: 0 };
  order.forEach((k, i) => (m["await_" + k.replace(/^ask_/, "")] = i + 1));
  m["done"] = 9999;
  return m;
})();
const orderedAwait = Object.entries(stepIndexMap)
  .filter(([k]) => k.startsWith("await_"))
  .sort((a, b) => a[1] - b[1])
  .map(([k]) => k);
const stepIdx = (step) => stepIndexMap[step] ?? -1;
const maxStep = (curr, next) => (stepIdx(next) >= stepIdx(curr) ? next : curr);

async function setState(waId, newState) { await kvSet(waId, newState); }
async function getState(waId) { return (await kvGet(waId)) || { step: "idle", data: {}, docs: {}, hist: [] }; }
async function forceStep(waId, desiredStep) {
  const s = (await getState(waId)) || { step: "idle", data: {}, docs: {}, hist: [] };
  s.hist = Array.isArray(s.hist) ? s.hist : [];
  const curr = s.step || "idle";
  if (curr !== desiredStep && curr) s.hist.push(curr), (s.hist = s.hist.slice(-200));
  s.step = desiredStep;
  await kvSet(waId, s);
  return s.step;
}
function nextKeyAfter(currentAwaitKey) {
  const askKey = currentAwaitKey.replace("await_", "ask_");
  const idx = order.indexOf(askKey);
  if (idx === -1 || idx + 1 >= order.length) return null;
  return order[idx + 1];
}

// ---------- Flow pieces ----------
async function startIntro(pnid, from) {
  await waSend(pnid, from, intro);
  await WAIT(1200);
  await waSend(pnid, from, disabilityYesNo);
  await setState(from, { step: "await_disability", data: {}, docs: {}, hist: [] });
}
async function onDisabilityYes(pnid, from) {
  const s = await getState(from);
  s.data = s.data || {};
  s.data.disability_early = "Yes";
  if (!s.data._who_once_shown) {
    await waSend(pnid, from, whoCanApplyText);
    s.data._who_once_shown = true;
  }
  await kvSet(from, s);
  await WAIT(300);
  await waSend(pnid, from, disabilityList);
  s.step = maxStep(s.step, "await_disability_type");
  s.hist = s.hist || [];
  s.hist.push("await_disability");
  s.hist = s.hist.slice(-200);
  await setState(from, s);
}
async function onDisabilityNo(pnid, from) {
  const s = await getState(from);
  s.data = s.data || {};
  s.data.disability_early = "No";
  if (!s.data._who_once_shown) {
    await waSend(pnid, from, whoCanApplyText);
    s.data._who_once_shown = true;
    await WAIT(300);
  }
  await waSend(pnid, from, applyButton);
  s.hist = s.hist || [];
  s.hist.push("await_disability");
  s.hist = s.hist.slice(-200);
  s.step = maxStep(s.step, "await_apply");
  await setState(from, s);
}
async function onDisabilityTypeChosen(pnid, from, listId) {
  const s = await getState(from);
  s.data = s.data || {};
  s.data.disability_type = listId;
  s.hist = s.hist || [];
  s.hist.push("await_disability");
  s.hist = s.hist.slice(-200);
  if (listId === "disability_other") {
    s.step = maxStep(s.step, "await_disability_other_text");
    await setState(from, s);
    await waSend(pnid, from, describeDisability);
    return;
  } else {
    await waSend(pnid, from, applyButton);
    s.step = maxStep(s.step, "await_apply");
    await setState(from, s);
  }
}
async function onApplyStart(pnid, from) {
  const s = await getState(from);
  s.hist = s.hist || [];
  s.hist.push("await_apply");
  s.hist = s.hist.slice(-200);
  s.step = maxStep(s.step, "await_first_name");
  await setState(from, s);
  await sendPromptWithBack(pnid, from, "ask_first_name");
}

// Generic capture & advance (branches + docs entry)
async function captureAndAdvance(pnid, from, field, value, currentAwaitKey, validator) {
  const s = await getState(from);
  s.data = s.data || {};
  const ok = validator ? validator(value) : true;
  if (!ok) {
    await WAIT(200);
    await sendPromptWithBack(pnid, from, currentAwaitKey.replace("await_", "ask_"));
    s.step = maxStep(s.step, currentAwaitKey);
    await setState(from, s);
    return;
  }
  s.data[field] = value;

  // Learnership → SETA question
  if (currentAwaitKey === "await_done_learnership" && value === true) {
    s.hist = s.hist || [];
    s.hist.push(currentAwaitKey);
    s.hist = s.hist.slice(-200);
    s.step = maxStep(s.step, "await_ceta");
    await setState(from, s);
    await WAIT(250);
    await sendPromptWithBack(pnid, from, "ask_ceta");
    return;
  }

  // Currently studying → branch
  if (currentAwaitKey === "await_currently_studying") {
    s.hist = s.hist || [];
    s.hist.push(currentAwaitKey);
    s.hist = s.hist.slice(-200);
    if (value === true) {
      s.step = maxStep(s.step, "await_study_type");
      await setState(from, s);
      await WAIT(250);
      await sendPromptWithBack(pnid, from, "ask_study_type");
    } else {
      s.step = maxStep(s.step, "await_employed");
      await setState(from, s);
      await WAIT(250);
      await sendPromptWithBack(pnid, from, "ask_employed");
    }
    return;
  }

  // Enter documents section
  const nextKey = nextKeyAfter(currentAwaitKey);
  if (nextKey === "ask_cv_upload") {
    s.hist = s.hist || [];
    s.hist.push(currentAwaitKey);
    s.hist = s.hist.slice(-200);
    s.step = maxStep(s.step, "await_cv_upload");
    await setState(from, s);
    await waSend(pnid, from, buildDocsIntroPayload(s));
    await WAIT(400);
    await sendPromptWithBack(pnid, from, "ask_cv_upload");
    return;
  }

  // Normal advance
  if (nextKey) {
    s.hist = s.hist || [];
    s.hist.push(currentAwaitKey);
    s.hist = s.hist.slice(-200);
    s.step = maxStep(s.step, nextKey.replace("ask_", "await_"));
    await setState(from, s);
    await WAIT(250);
    await sendPromptWithBack(pnid, from, nextKey);
  } else {
    // End → summary then submit
    s.hist = s.hist || [];
    s.hist.push(currentAwaitKey);
    s.hist = s.hist.slice(-200);
    s.step = maxStep(s.step, "await_submit");
    await setState(from, s);
    await sendSummaryOnly(pnid, from, s.data || {}, s.docs || {});
    await WAIT(250);
    await sendPromptWithBack(pnid, from, "ask_submit");
  }
}

// Docs helper with conditional routing (SARS compulsory; Disability doc may be compulsory)
async function captureDocAndNext(pnid, from, currentAwaitKey) {
  const s = await getState(from);
  let nextKey = nextKeyAfter(currentAwaitKey);

  // Ensure specific jumps
  if (currentAwaitKey === "await_qual_upload") nextKey = "ask_sars_upload"; // SARS is compulsory
  if (currentAwaitKey === "await_sars_upload") nextKey = "ask_bank_upload";
  if (currentAwaitKey === "await_bank_upload") {
    nextKey = (s?.data?.disability_early || "") === "Yes" ? "ask_disability_doc_upload" : "ask_disability_doc_optional";
  }

  if (nextKey) {
    s.hist = s.hist || [];
    s.hist.push(currentAwaitKey);
    s.hist = s.hist.slice(-200);
    s.step = maxStep(s.step, nextKey.replace("ask_", "await_"));
    await setState(from, s);
    await WAIT(250);
    await sendPromptWithBack(pnid, from, nextKey);
  } else {
    s.hist = s.hist || [];
    s.hist.push(currentAwaitKey);
    s.hist = s.hist.slice(-200);
    s.step = maxStep(s.step, "await_submit");
    await setState(from, s);
    await sendSummaryOnly(pnid, from, s.data || {}, s.docs || {});
    await WAIT(250);
    await sendPromptWithBack(pnid, from, "ask_submit");
  }
}

// ---------- Summary & Thanks ----------
async function sendSummaryOnly(pnid, from, d, docs) {
  const yesNo = (v) => (v === true ? "Yes" : v === false ? "No" : v || "");
  const docLine = (label, obj) => `• ${label}: ${obj ? obj.filename || obj.id || "received" : "—"}`;
  const sarsLabel = "SARS Tax Reference Letter *";
  const disLabel = (d.disability_early || "") === "Yes" ? "Proof Of Disability Document *" : "Proof Of Disability Document";

  const summary =
    "*Application Summary*\n\n" +
    "*Personal Details*\n" +
    `• Name: ${d.first_name || ""} ${d.last_name || ""}\n` +
    `• South African ID: ${d.id_number || ""}\n` +
    `• Race: ${d.race || ""}\n` +
    `• Gender: ${d.gender || ""}\n` +
    `• Disability (early): ${d.disability_early || ""}${d.disability_type ? ` (${d.disability_type})` : ""}\n\n` +
    "*Contact details*\n" +
    `• Contact number: ${d.contact_number || ""}\n` +
    `• Email: ${d.email || ""}\n` +
    `• Address: ${d.street || ""}, ${d.city || ""}, ${d.province || ""} ${d.postal_code || ""}\n\n` +
    "*Education & Employment*\n" +
    `• Highest grade passed: ${d.highest_grade || ""}\n` +
    `• Last school attended: ${d.last_school || ""}\n` +
    `• Done a learnership before: ${yesNo(d.done_learnership)}\n` +
    (d.done_learnership ? `• SETA certificate: ${yesNo(d.ceta_certificate)}\n` : "") +
    (d.prev_qualification ? `• Previous qualification: ${d.prev_qualification}\n` : "") +
    (d.prev_when ? `• Completed: ${d.prev_when}\n` : "") +
    `• Currently studying: ${yesNo(d.currently_studying)}${d.currently_studying ? ` (${d.study_type || ""})` : ""}\n` +
    `• Currently employed: ${yesNo(d.currently_employed)}\n\n` +
    "*Documents*\n" +
    docLine("Updated CV *", docs.cv) + "\n" +
    docLine("Certified ID copy *", docs.id_copy) + "\n" +
    docLine("Highest qualification / latest school report *", docs.qualification) + "\n" +
    docLine(sarsLabel, docs.sars) + "\n" +
    docLine("Bank statement / bank confirmation letter *", docs.bank) + "\n" +
    docLine(disLabel, docs.disability_doc);

  await waSend(pnid, from, {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: summary },
  });
}
async function sendThanks(pnid, from) {
  await waSend(pnid, from, {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: { body: "Thanks! We’ve recorded your details. ✅" },
  });

  // New heads-up message (always send after submit)
  await WAIT(250);
  await waSend(pnid, from, {
    messaging_product: "whatsapp",
    to: "@FROM@",
    type: "text",
    text: {
      body:
        "Heads up: Once you’ve submitted an application, you *cannot re-upload documents* on WhatsApp and you *cannot* use this number to start a new application for another person — doing so will *erase/overwrite your application*.",
    },
  });
}

// ===========================================================================
// HTTP handler
export default async function handler(req, res) {
  // GET verify
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      res.status(200).setHeader("Content-Type", "text/plain").send(challenge || "");
    } else {
      res.status(403).setHeader("Content-Type", "text/plain").send("Forbidden");
    }
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const body = typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    const from = msg?.from;
    const pnid = value?.metadata?.phone_number_id;
    const type = msg?.type;
    const msgId = msg?.id;

    const originalText = (msg?.text?.body || "").trim();
    const textLc = lc(originalText);

    const btnId = msg?.interactive?.button_reply?.id || "";
    const listId = msg?.interactive?.list_reply?.id || "";
    const listTitle = msg?.interactive?.list_reply?.title || "";
    const iType = msg?.interactive?.type || "";

    // Debug helper response
    const debug = process.env.DEBUG_TEST === "1" || req.headers["x-debug"] === "1";
    const respond = async (extra = {}) => {
      if (debug) {
        const s = from ? await getState(from) : undefined;
        return res.status(200).json({ ok: true, step: s?.step, ...extra });
      }
      return res.status(200).json({ ok: true, ...extra });
    };

    if (!from || !pnid) return respond();

    // Testing / restart
    if (req.headers["x-reset"] === "1") await resetState(from);
    if (type === "text") {
      const t = lc(originalText);
      if (["reset", "restart", "start over", "hello", "hi"].includes(t)) {
        await resetState(from);
        await startIntro(pnid, from);
        return respond();
      }
    }

    // Load state & idempotency
    let state = await getState(from);
    state.last_msg_id = state.last_msg_id || "";
    if (msgId && state.last_msg_id === msgId) return respond({ dedup: true });
    state.last_msg_id = msgId || state.last_msg_id;
    await setState(from, state);

    // Entry word
    if (type === "text" && ["hi", "hello", "apply", "start"].includes(textLc) && state.step === "idle") {
      await startIntro(pnid, from);
      return respond();
    }

    // Disability section
    if (state.step === "await_disability") {
      if (btnId === "disability_yes" || textLc === "yes") {
        await onDisabilityYes(pnid, from);
        return respond();
      }
      if (btnId === "disability_no" || textLc === "no") {
        await onDisabilityNo(pnid, from);
        return respond();
      }
      await waSend(pnid, from, disabilityYesNo);
      return respond();
    }
    if (
      state.step === "await_disability_type" &&
      (iType === "list_reply" || msg?.interactive?.list_reply) &&
      (listId || listTitle)
    ) {
      await onDisabilityTypeChosen(pnid, from, listId || "");
      return respond();
    }
    if (state.step === "await_disability_other_text" && type === "text" && originalText) {
      state.data.disability_other_desc = originalText;
      state.hist = state.hist || [];
      state.hist.push("await_disability_other_text");
      state.hist = state.hist.slice(-200);
      state.step = maxStep(state.step, "await_apply");
      await setState(from, state);
      await waSend(pnid, from, applyButton);
      return respond();
    }

    // Apply start
    if ((state.step === "await_apply" && btnId === "apply_start") || (btnId === "apply_start" && state.step !== "done")) {
      await onApplyStart(pnid, from);
      return respond();
    }

    // Main state machine
    if (state.step?.startsWith("await_")) {
      switch (state.step) {
        // Personal
        case "await_first_name":
          if (type === "text" && originalText)
            await captureAndAdvance(pnid, from, "first_name", originalText, "await_first_name");
          else await sendPromptWithBack(pnid, from, "ask_first_name");
          break;

        case "await_last_name":
          if (type === "text" && originalText)
            await captureAndAdvance(pnid, from, "last_name", originalText, "await_last_name");
          else await sendPromptWithBack(pnid, from, "ask_last_name");
          break;

        case "await_id": {
          const id = digits(originalText);
          if (type === "text" && id.length === 13) {
            const dob = parseDobFromSaId(id);
            if (!dob) {
              await sendPromptWithBack(pnid, from, "ask_id");
              break;
            }
            const age = ageFromDob(dob);
            if (age > 28) {
              await blockAndEnd(
                pnid,
                from,
                "We appreciate your interest, but *only candidates aged 18–28* can apply for a learnership."
              );
              break;
            }
            state.data = state.data || {};
            state.data.id_number = id;
            state.hist = state.hist || [];
            state.hist.push("await_id");
            state.hist = state.hist.slice(-200);
            state.step = maxStep(state.step, "await_race");
            await setState(from, state);
            await waSend(pnid, from, {
              messaging_product: "whatsapp",
              to: "@FROM@",
              type: "text",
              text: { body: "✅ Thanks, your ID was received." },
            });
            await WAIT(300);
            await sendPromptWithBack(pnid, from, "ask_race");
          } else {
            await sendPromptWithBack(pnid, from, "ask_id");
          }
          break;
        }

        // Race (LIST ONLY)
        case "await_race": {
          const lr = msg?.interactive?.list_reply || {};
          const choiceKey = lr.id && /^race_/.test(lr.id) ? lr.id : "";
          if (choiceKey) {
            const s = await getState(from);
            s.data = s.data || {};
            s.data.race = raceTitle(choiceKey);
            s.hist = s.hist || [];
            s.hist.push("await_race");
            s.hist = s.hist.slice(-200);
            s.step = maxStep(s.step, "await_gender");
            await setState(from, s);
            await WAIT(250);
            await sendPromptWithBack(pnid, from, "ask_gender");
          } else {
            await sendPromptWithBack(pnid, from, "ask_race");
          }
          break;
        }

        // Gender
        case "await_gender": {
          const mapBtn = { gender_male: "Male", gender_female: "Female" };
          const key = mapBtn[btnId] ? btnId : "";
          if (key) await captureAndAdvance(pnid, from, "gender", mapBtn[key], "await_gender");
          else await sendPromptWithBack(pnid, from, "ask_gender");
          break;
        }

        // Contact (updated)
        case "await_contact_intro":
          if (btnId === "use_wa_number") {
            let msisdn = from;
            if (/^\d+$/.test(msisdn) && msisdn.startsWith("27") && msisdn.length >= 11) {
              state.data.contact_number = "0" + msisdn.slice(2); // 27xxxxxxxxx -> 0xxxxxxxxx
            } else {
              state.data.contact_number = from;
            }

            state.hist = state.hist || [];
            state.hist.push("await_contact_intro");
            state.hist = state.hist.slice(-200);

            // ⬇️ Skip phone prompt; jump straight to Email
            state.step = maxStep(state.step, "await_email");
            await setState(from, state);
            await sendPromptWithBack(pnid, from, "ask_email");
          } else if (btnId === "enter_phone") {
            state.hist = state.hist || [];
            state.hist.push("await_contact_intro");
            state.hist = state.hist.slice(-200);
            state.step = maxStep(state.step, "await_phone_full");
            await setState(from, state);
            await sendPromptWithBack(pnid, from, "ask_phone_full");
          } else {
            await sendPromptWithBack(pnid, from, "ask_contact_intro");
          }
          break;

        case "await_phone_full": {
          const n = digits(originalText);
          if (n.length === 10 && n.startsWith("0")) {
            await captureAndAdvance(pnid, from, "contact_number", n, "await_phone_full");
          } else {
            await sendPromptWithBack(pnid, from, "ask_phone_full");
          }
          break;
        }

        case "await_email":
          if (type === "text" && validEmail(originalText))
            await captureAndAdvance(pnid, from, "email", originalText, "await_email");
          else await sendPromptWithBack(pnid, from, "ask_email");
          break;

        case "await_street":
          if (type === "text" && originalText)
            await captureAndAdvance(pnid, from, "street", originalText, "await_street");
          else await sendPromptWithBack(pnid, from, "ask_street");
          break;

        case "await_city":
          if (type === "text" && originalText)
            await captureAndAdvance(pnid, from, "city", originalText, "await_city");
          else await sendPromptWithBack(pnid, from, "ask_city");
          break;

        case "await_province":
          if ((iType === "list_reply" || msg?.interactive?.list_reply) && listId?.startsWith("province_"))
            await captureAndAdvance(pnid, from, "province", provinceTitle(listId), "await_province");
          else await sendPromptWithBack(pnid, from, "ask_province");
          break;

        case "await_postal":
          if (type === "text" && validPostal(originalText))
            await captureAndAdvance(pnid, from, "postal_code", originalText, "await_postal");
          else await sendPromptWithBack(pnid, from, "ask_postal");
          break;

        // Education & Employment
        case "await_highest_grade":
          if ((iType === "list_reply" || msg?.interactive?.list_reply) && /^grade_1[0-2]$/.test(listId || "")) {
            const map = { grade_10: "Grade 10", grade_11: "Grade 11", grade_12: "Grade 12" };
            await captureAndAdvance(pnid, from, "highest_grade", map[listId] || listId, "await_highest_grade");
          } else {
            await sendPromptWithBack(pnid, from, "ask_highest_grade");
          }
          break;

        case "await_last_school":
          if (type === "text" && originalText)
            await captureAndAdvance(pnid, from, "last_school", originalText, "await_last_school");
          else await sendPromptWithBack(pnid, from, "ask_last_school");
          break;

        case "await_done_learnership": {
          const yes = btnId === "learnership_yes";
          const no = btnId === "learnership_no";
          if (yes || no) await captureAndAdvance(pnid, from, "done_learnership", yes, "await_done_learnership");
          else await sendPromptWithBack(pnid, from, "ask_done_learnership");
          break;
        }

        case "await_ceta":
          if (btnId === "ceta_yes" || btnId === "ceta_no") {
            state.data = state.data || {};
            state.data.ceta_certificate = btnId === "ceta_yes";
            state.hist = state.hist || [];
            state.hist.push("await_ceta");
            state.hist = state.hist.slice(-200);

            // After SETA → ask previous qualification + when (only when done_learnership === true)
            if (state.data.done_learnership === true) {
              state.step = maxStep(state.step, "await_prev_qualification");
              await setState(from, state);
              await sendPromptWithBack(pnid, from, "ask_prev_qualification");
            } else {
              state.step = maxStep(state.step, "await_currently_studying");
              await setState(from, state);
              await sendPromptWithBack(pnid, from, "ask_currently_studying");
            }
          } else {
            await sendPromptWithBack(pnid, from, "ask_ceta");
          }
          break;

        case "await_prev_qualification":
          if (type === "text" && originalText) {
            await captureAndAdvance(pnid, from, "prev_qualification", originalText, "await_prev_qualification");
          } else {
            await sendPromptWithBack(pnid, from, "ask_prev_qualification");
          }
          break;

        case "await_prev_when":
          if (type === "text" && originalText) {
            await captureAndAdvance(pnid, from, "prev_when", originalText, "await_prev_when");
          } else {
            await sendPromptWithBack(pnid, from, "ask_prev_when");
          }
          break;

        case "await_currently_studying": {
          const yes = btnId === "studying_yes";
          const no = btnId === "studying_no";
          if (yes || no)
            await captureAndAdvance(pnid, from, "currently_studying", yes, "await_currently_studying");
          else await sendPromptWithBack(pnid, from, "ask_currently_studying");
          break;
        }

        case "await_study_type":
          if (btnId === "part_time" || btnId === "full_time") {
            if (btnId === "full_time") {
              await blockAndEnd(
                pnid,
                from,
                "Thanks for applying. *Only Part-Time online students* are eligible for a learnership."
              );
              break;
            }
            state.data = state.data || {};
            state.data.study_type = "Part-Time";
            state.hist = state.hist || [];
            state.hist.push("await_study_type");
            state.hist = state.hist.slice(-200);
            state.step = maxStep(state.step, "await_employed");
            await setState(from, state);
            await WAIT(250);
            await sendPromptWithBack(pnid, from, "ask_employed");
          } else {
            await sendPromptWithBack(pnid, from, "ask_study_type");
          }
          break;

        case "await_employed": {
          const yes = btnId === "employ_yes";
          const no = btnId === "employ_no";
          if (yes) {
            await blockAndEnd(
              pnid,
              from,
              "Thanks for applying. *Only unemployed candidates* can apply for a learnership."
            );
          } else if (no) {
            await captureAndAdvance(pnid, from, "currently_employed", false, "await_employed");
          } else {
            await sendPromptWithBack(pnid, from, "ask_employed");
          }
          break;
        }

        // ----- Documents -----
        case "await_cv_upload": {
          const media = extractMedia(msg);
          if (media) {
            state.docs = state.docs || {};
            state.docs.cv = media;
            await setState(from, state);
            await captureDocAndNext(pnid, from, "await_cv_upload");
          } else {
            await sendPromptWithBack(pnid, from, "ask_cv_upload");
          }
          break;
        }

        case "await_id_upload": {
          const media = extractMedia(msg);
          if (media) {
            state.docs = state.docs || {};
            state.docs.id_copy = media;
            await setState(from, state);
            await captureDocAndNext(pnid, from, "await_id_upload");
          } else {
            await sendPromptWithBack(pnid, from, "ask_id_upload");
          }
          break;
        }

        case "await_qual_upload": {
          const media = extractMedia(msg);
          if (media) {
            state.docs = state.docs || {};
            state.docs.qualification = media;
            await setState(from, state);
            await captureDocAndNext(pnid, from, "await_qual_upload");
          } else {
            await sendPromptWithBack(pnid, from, "ask_qual_upload");
          }
          break;
        }

        case "await_sars_upload": {
          const media = extractMedia(msg);
          if (media) {
            state.docs = state.docs || {};
            state.docs.sars = media;
            await setState(from, state);
            await captureDocAndNext(pnid, from, "await_sars_upload"); // → Bank
          } else {
            await sendPromptWithBack(pnid, from, "ask_sars_upload");
          }
          break;
        }

        case "await_bank_upload": {
          const media = extractMedia(msg);
          if (media) {
            state.docs = state.docs || {};
            state.docs.bank = media;
            await setState(from, state);
            await captureDocAndNext(pnid, from, "await_bank_upload"); // → Disability optional or mandatory
          } else {
            await sendPromptWithBack(pnid, from, "ask_bank_upload");
          }
          break;
        }

        case "await_disability_doc_optional": {
          const wantsUpload =
            btnId === "upload_disability_doc" || ["upload now", "upload", "yes", "y"].includes(textLc);
          const wantsSkip =
            btnId === "skip_disability_doc" || ["skip", "no", "n", "later", "not now"].includes(textLc);

          if (wantsUpload) {
            state.hist = state.hist || [];
            state.hist.push("await_disability_doc_optional");
            state.hist = state.hist.slice(-200);
            state.step = maxStep(state.step, "await_disability_doc_upload");
            await setState(from, state);
            await sendPromptWithBack(pnid, from, "ask_disability_doc_upload");
          } else if (wantsSkip) {
            state.hist = state.hist || [];
            state.hist.push("await_disability_doc_optional");
            state.hist = state.hist.slice(-200);
            state.step = maxStep(state.step, "await_submit");
            await setState(from, state);
            await sendSummaryOnly(pnid, from, state.data || {}, state.docs || {});
            await WAIT(250);
            await sendPromptWithBack(pnid, from, "ask_submit");
          } else {
            await sendPromptWithBack(pnid, from, "ask_disability_doc_optional");
          }
          break;
        }

        case "await_disability_doc_upload": {
          const media = extractMedia(msg);
          if (media) {
            state.docs = state.docs || {};
            state.docs.disability_doc = media;
            await setState(from, state);
            state.hist = state.hist || [];
            state.hist.push("await_disability_doc_upload");
            state.hist = state.hist.slice(-200);
            state.step = maxStep(state.step, "await_submit");
            await setState(from, state);
            await sendSummaryOnly(pnid, from, state.data || {}, state.docs || {});
            await WAIT(250);
            await sendPromptWithBack(pnid, from, "ask_submit");
          } else {
            // Mandatory when disability_early === "Yes" — keep asking
            await sendPromptWithBack(pnid, from, "ask_disability_doc_upload");
          }
          break;
        }

        case "await_submit":
          if (btnId === "submit_application") {
            state.step = "done";
            await setState(from, state);
            const payload = { whatsapp_id: from, data: state.data || {}, docs: state.docs || {} };
            const pa = await pushToFlow(payload);
            await sendThanks(pnid, from);

            // Old failure-only heads-up (commented out as requested)
            /*
            if (!pa?.ok) {
              await waSend(pnid, from, {
                messaging_product: "whatsapp",
                to: "@FROM@",
                type: "text",
                text: {
                  body: "Heads up: I couldn't confirm with our system just now, but your application was captured. We'll sync it shortly.",
                },
              });
            }
            */
          } else {
            await sendSummaryOnly(pnid, from, state.data || {}, state.docs || {});
            await WAIT(250);
            await sendPromptWithBack(pnid, from, "ask_submit");
          }
          break;

        default: {
          const askKey = "ask_" + state.step.replace(/^await_/, "");
          if (prompts[askKey]) await sendPromptWithBack(pnid, from, askKey);
          else {
            await waSend(pnid, from, applyButton);
          }
          break;
        }
      }
      return respond();
    }

    // Fallback mid-flow
    if (state.step && state.step.startsWith("await_")) {
      const askKey = "ask_" + state.step.replace(/^await_/, "");
      if (prompts[askKey]) {
        await sendPromptWithBack(pnid, from, askKey);
        return respond();
      }
    }

    // Fresh start
    await waSend(pnid, from, applyButton);
    return respond();
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
