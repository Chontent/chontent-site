// netlify/functions/stripe-webhook.mjs
//
// Listens for Stripe "checkout.session.completed" events and emails the
// Starter Guide PDF straight to the buyer — no public download link, no
// third-party automation tool (Zapier/Pabbly). Just Stripe + Netlify + Gmail,
// all of which chontent.com already uses or can use for free.
//
// Required Netlify environment variables (set in Site settings > Environment
// variables, NOT committed to the repo):
//   STRIPE_SECRET_KEY      - your Stripe secret key (sk_live_... or sk_test_...)
//   STRIPE_WEBHOOK_SECRET  - the signing secret Stripe gives you when you add
//                            this endpoint as a webhook (whsec_...)
//   GMAIL_USER             - the Gmail address to send from
//   GMAIL_APP_PASSWORD     - a Gmail "app password" (Google Account > Security
//                            > 2-Step Verification > App passwords) — NOT your
//                            normal Gmail password
//
// Stripe dashboard setup:
//   Developers > Webhooks > Add endpoint
//   URL: https://chontent.com/api/stripe-webhook
//   Event to send: checkout.session.completed

import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __fnDirname = path.dirname(fileURLToPath(import.meta.url));
const PDF_PATH = path.join(__fnDirname, 'files', 'How-to-Become-a-Christian.pdf');

// The Price ID of the Starter Guide product — only a purchase of this price
// triggers the auto-email. Everything else (e.g. the call booking) is left
// alone and handled manually, same as before.
const GUIDE_PRICE_ID = 'price_1USCcjPmM826Rzhs74xuCttf';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async (req, context) => {
    if (req.method !== 'POST') {
          return new Response('Method not allowed', { status: 405 });
    }

    const signature = req.headers.get('stripe-signature');
    const rawBody = await req.text();

    let event;
    try {
          event = stripe.webhooks.constructEvent(
                  rawBody,
                  signature,
                  process.env.STRIPE_WEBHOOK_SECRET
                );
    } catch (err) {
          console.error('Webhook signature verification failed:', err.message);
          return new Response(`Webhook Error: ${err.message}`, { status: 400 });
    }

    if (event.type !== 'checkout.session.completed') {
          // Not a purchase completion — acknowledge and ignore.
      return new Response('ignored', { status: 200 });
    }

    const session = event.data.object;

    // Only send the guide for an actual guide purchase, not for call bookings.
    // Checkout Sessions from a Payment Link don't include line items by
    // default, so re-fetch with expand and check the price ID.
    let isGuidePurchase = false;
    try {
          const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
                  expand: ['line_items'],
          });
          const items = fullSession.line_items?.data || [];
          isGuidePurchase = items.some((item) => item.price?.id === GUIDE_PRICE_ID);
    } catch (err) {
          console.error('Could not expand line items — not sending anything:', err.message);
          return new Response('could not verify line items', { status: 200 });
    }

    const email = session.customer_details?.email || session.customer_email;

    if (!email) {
          console.error('No customer email on session', session.id);
          return new Response('no email on session', { status: 200 });
    }

    if (!isGuidePurchase) {
          return new Response('ok', { status: 200 });
    }

    try {
          const pdfBuffer = fs.readFileSync(PDF_PATH);

      const transporter = nodemailer.createTransport({
              service: 'gmail',
              auth: {
                        user: process.env.GMAIL_USER,
                        pass: process.env.GMAIL_APP_PASSWORD,
              },
      });

      await transporter.sendMail({
              from: `PreachersRealm <${process.env.GMAIL_USER}>`,
              to: email,
              subject: 'Your Starter Guide — How to Become a Christian',
              text:
                        "Thanks for grabbing the guide — it's attached as a PDF.\n\n" +
                        "It's written to go with the first video on the PreachersRealm channel, " +
                        "so if you haven't watched it yet, that's a good place to start too.\n\n" +
                        "If anything in the guide raises a question you'd like to talk through, " +
                        "you can always book a call at chontent.com/#call.\n\n" +
                        "— Yves, PreachersRealm",
              html:
                        `<p>Thanks for grabbing the guide — it's attached as a PDF.</p>` +
                        `<p>It's written to go with the first video on the PreachersRealm channel, ` +
                        `so if you haven't watched it yet, that's a good place to start too.</p>` +
                        `<p>If anything in the guide raises a question you'd like to talk through, ` +
                        `you can always <a href="https://chontent.com/#call">book a call</a>.</p>` +
                        `<p>— Yves, PreachersRealm</p>`,
              attachments: [
                {
                            filename: 'How-to-Become-a-Christian.pdf',
                            content: pdfBuffer,
                            contentType: 'application/pdf',
                },
                      ],
      });

      console.log('Guide emailed to', email);
          return new Response('ok', { status: 200 });
    } catch (err) {
          console.error('Failed to send guide email:', err);
          // Return 500 so Stripe retries the webhook automatically. The actual
      // error message is included in the body so it shows up directly in
      // Stripe Dashboard > Developers > Webhooks > this endpoint > the event >
      // "Response" — no need to dig through Netlify logs to see why it failed.
      return new Response('email send failed: ' + err.message, { status: 500 });
    }
};

export const config = {
    path: '/api/stripe-webhook',
};
