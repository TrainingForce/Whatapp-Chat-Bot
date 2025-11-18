// --- WhatsApp Enquiry + FAQ Version ---
// (Learnership flow disabled - for future use)

const stateMem = new Map();

const FLOW_URL =
  process.env.PA_FLOW_URL ||
  "https://flow-url-here"; // Keep your existing link

const WAIT = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const lc = (x) => (x || "").toString().trim().toLowerCase();

async function kvGet(key) { return stateMem.get(key); }
async function kvSet(key, value) { stateMem.set(key, value); }
async function resetState(waId) { await kvSet(waId, { step: "idle", data: {}, docs: {}, hist: [] }); }

async function waSend(pnid, to, payload) {
  const url = `https://graph.facebook.com/v22.0/${pnid}/messages`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload).replaceAll("@FROM@", to),
  }).catch(() => {});
}

async function pushToFlow({ whatsapp_id, data }) {
  try {
    await fetch(FLOW_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ whatsapp_id, data }),
    });
  } catch (e) {
    console.error("PA Error", e);
  }
}

// --- Main Start Menu ---
const startMenu = {
  messaging_product: "whatsapp",
  to: "@FROM@",
  type: "interactive",
  interactive: {
    type: "button",
    body: { text: "👋 Welcome! How can we assist you today?" },
    action: {
      buttons: [
        { type: "reply", reply: { id: "menu_query", title: "🔵 I Have a Query" } },
        { type: "reply", reply: { id: "menu_apply", title: "🟢 Apply for Learnership" } },
        { type: "reply", reply: { id: "menu_faq", title: "❓ FAQs" } },
      ],
    },
  },
};

// --- FAQ Menu ---
const faqMenu = {
  messaging_product: "whatsapp",
  to: "@FROM@",
  type: "interactive",
  interactive: {
    type: "button",
    body: {
      text: "📘 Frequently Asked Questions\n\nSelect a question below:",
    },
    action: {
      buttons: [
        { type: "reply", reply: { id: "faq_enrol", title: "Enrol as individual?" } },
        { type: "reply", reply: { id: "faq_tax", title: "12H Tax Allowance?" } },
        { type: "reply", reply: { id: "faq_onsite", title: "On-site training?" } },
        { type: "reply", reply: { id: "faq_duration", title: "Course duration?" } },
        { type: "reply", reply: { id: "faq_difference", title: "Learnership vs Skills?" } },
      ],
    },
  },
};

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const body = req.body;
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    const from = msg?.from;
    const pnid = value?.metadata?.phone_number_id;
    const type = msg?.type;
    const originalText = msg?.text?.body || "";
    const textLc = lc(originalText);
    const btnId = msg?.interactive?.button_reply?.id || "";

    if (!from || !pnid) return res.status(200).json({ ok: true });

    // --- NEW: Always start with Main Menu (any time user says Hi, Hello, Start)
    if (textLc === "hi" || textLc === "hello" || textLc === "start") {
      await resetState(from);
      await waSend(pnid, from, startMenu);
      await kvSet(from, { step: "await_start_menu", data: {} });
      return res.status(200).json({ ok: true });
    }

    // --- Load state
    let state = (await kvGet(from)) || { step: "idle", data: {} };

    // --- If first time → show main menu
    if (state.step === "idle") {
      await resetState(from);
      await waSend(pnid, from, startMenu);
      await kvSet(from, { step: "await_start_menu", data: {} });
      return res.status(200).json({ ok: true });
    }

    // --- MENU LOGIC ---
    if (state.step === "await_start_menu") {
      if (btnId === "menu_query") {
        state.step = "await_query_text";
        await kvSet(from, state);
        await waSend(pnid, from, {
          messaging_product: "whatsapp",
          to: "@FROM@",
          type: "text",
          text: { body: "💬 Please type your query below:" },
        });
        return res.status(200).json({ ok: true });
      }

      if (btnId === "menu_apply") {
        await waSend(pnid, from, {
          messaging_product: "whatsapp",
          to: "@FROM@",
          type: "text",
          text: { body: "🛠 Learnership application process is coming soon. For now, choose *Query* or *FAQs*." },
        });
        return res.status(200).json({ ok: true });
      }

      if (btnId === "menu_faq") {
        state.step = "await_faq_choice";
        await kvSet(from, state);
        await waSend(pnid, from, faqMenu);
        return res.status(200).json({ ok: true });
      }

      // If invalid, show menu again
      await waSend(pnid, from, startMenu);
      return res.status(200).json({ ok: true });
    }

    // --- FAQ RESPONSES ---
    if (state.step === "await_faq_choice") {
      const answers = {
        faq_enrol: "Yes — individuals can enrol independently, and our courses lead to recognised qualifications.",
        faq_tax: "Yes — we help businesses claim 12H tax allowances with expert guidance through the process.",
        faq_onsite: "Yes — we provide on-site training at your location, our facility, or a venue of choice.",
        faq_duration: "Training duration varies: 1-day short courses to 12-month learnerships.",
        faq_difference:
          "Learnerships are full qualifications (NQF-aligned). Skills programmes are short, focused, not full qualifications.",
      };

      if (answers[btnId]) {
        await waSend(pnid, from, {
          messaging_product: "whatsapp",
          to: "@FROM@",
          type: "text",
          text: { body: answers[btnId] },
        });
        await WAIT(300);
        await waSend(pnid, from, startMenu); // Go back to menu
        state.step = "await_start_menu";
        await kvSet(from, state);
        return res.status(200).json({ ok: true });
      }

      await waSend(pnid, from, faqMenu);
      return res.status(200).json({ ok: true });
    }

    // --- QUERY RESPONSE HANDLING ---
    if (state.step === "await_query_text" && type === "text") {
      state.data.query_message = originalText;
      await kvSet(from, state);

      // Send to Power Automate
      await pushToFlow({ whatsapp_id: from, data: state.data });

      await waSend(pnid, from, {
        messaging_product: "whatsapp",
        to: "@FROM@",
        type: "text",
        text: { body: "🙏 Thank you! Your query has been received. We will get back to you." },
      });

      await WAIT(400);
      await waSend(pnid, from, startMenu);
      state.step = "await_start_menu";
      await kvSet(from, state);
      return res.status(200).json({ ok: true });
    }

    // 🔄 Fallback: Show menu again
    await waSend(pnid, from, startMenu);
    await kvSet(from, { step: "await_start_menu", data: {} });
    return res.status(200).json({ ok: true });

  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: false, error: String(e) });
  }
}
