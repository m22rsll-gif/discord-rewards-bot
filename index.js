// ============================================================
//  Discord Rewards Bot — discord.js v14
//  Surveille les salons résultats & témoignages et attribue
//  des crédits dans Supabase.
// ============================================================

require('dotenv').config();

const { Client, GatewayIntentBits, Events } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// ─── Validation des variables d'environnement ─────────────────────────────────
const REQUIRED_ENV = [
  'DISCORD_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'CHANNEL_RESULTS_ID',
  'CHANNEL_TESTIMONIALS_ID',
];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Variable manquante dans .env : ${key}`);
    process.exit(1);
  }
}

const CHANNEL_RESULTS_ID      = process.env.CHANNEL_RESULTS_ID;
const CHANNEL_TESTIMONIALS_ID = process.env.CHANNEL_TESTIMONIALS_ID;

// ─── Clients ─────────────────────────────────────────────────────────────────
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Récupère l'utilisateur depuis Supabase, le crée s'il n'existe pas.
 * @param {import('discord.js').GuildMember} member
 * @returns {Promise<Object>} user row
 */
async function getOrCreateUser(member) {
  const { data: existing, error: fetchError } = await supabase
    .from('users')
    .select('*')
    .eq('discord_id', member.id)
    .maybeSingle();

  if (fetchError) throw new Error(`Supabase fetch error: ${fetchError.message}`);
  if (existing)   return existing;

  const { data: created, error: insertError } = await supabase
    .from('users')
    .insert({
      discord_id:       member.id,
      discord_username: member.user.username,
      discord_avatar:   member.user.avatar ?? null,
    })
    .select()
    .single();

  if (insertError) throw new Error(`Supabase insert error: ${insertError.message}`);
  console.log(`👤 Nouvel utilisateur enregistré : ${member.user.username} (${member.id})`);
  return created;
}

/**
 * Vérifie si l'utilisateur a déjà gagné un crédit "result" aujourd'hui (UTC).
 * @param {string} userId — UUID interne (pas le discord_id)
 * @returns {Promise<boolean>}
 */
async function hasResultCreditToday(userId) {
  // Début de la journée UTC
  const todayUTC = new Date();
  todayUTC.setUTCHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('transactions')
    .select('id')
    .eq('user_id', userId)
    .eq('type', 'result')
    .gte('created_at', todayUTC.toISOString())
    .limit(1);

  if (error) throw new Error(`Supabase check error: ${error.message}`);
  return data.length > 0;
}

/**
 * Envoie un DM à un utilisateur (échoue silencieusement si DM bloqués).
 * @param {import('discord.js').User} user
 * @param {string} content
 */
async function sendDM(user, content) {
  try {
    await user.send(content);
  } catch {
    // L'utilisateur a peut-être désactivé les DMs — pas critique
  }
}

// ─── Événement : bot prêt ─────────────────────────────────────────────────────
discord.once(Events.ClientReady, (c) => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  ✅ Bot connecté : ${c.user.tag.padEnd(22)}║`);
  console.log(`║  📢 Salon résultats    : ${CHANNEL_RESULTS_ID.slice(-8).padEnd(16)}║`);
  console.log(`║  📢 Salon témoignages : ${CHANNEL_TESTIMONIALS_ID.slice(-8).padEnd(16)}║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

// ─── Événement : nouveau message ─────────────────────────────────────────────
discord.on(Events.MessageCreate, async (message) => {
  // Ignorer les bots et les messages hors serveur
  if (message.author.bot)    return;
  if (!message.guild)        return;
  if (!message.member)       return;

  const channelId = message.channelId;

  // ── Salon résultats ──────────────────────────────────────────────────────────
  if (channelId === CHANNEL_RESULTS_ID) {
    try {
      // Vérifier la présence d'une image
      const hasImage = message.attachments.some((att) => {
        if (!att.contentType) return false;
        return att.contentType.startsWith('image/');
      });

      if (!hasImage) {
        await message.react('❌');
        await sendDM(
          message.author,
          '❌ Tu dois envoyer une **photo** de ton résultat pour gagner un crédit.\n' +
          'Joins une image directement dans ton message. 📸'
        );
        console.log(`❌ Pas d'image dans le message de ${message.author.username}`);
        return;
      }

      const user = await getOrCreateUser(message.member);
      const alreadyToday = await hasResultCreditToday(user.id);

      if (alreadyToday) {
        // Déjà reçu un crédit aujourd'hui
        await message.react('⏳');
        await sendDM(
          message.author,
          '⏳ Tu as déjà gagné ton crédit aujourd\'hui. Reviens demain pour en gagner un nouveau ! 📅'
        );
        console.log(`⏳ Crédit déjà attribué aujourd'hui à : ${message.author.username}`);
        return;
      }

      // Attribuer +1 crédit
      const { error: updateError } = await supabase
        .from('users')
        .update({
          credits:      user.credits + 1,
          total_earned: user.total_earned + 1,
        })
        .eq('id', user.id);

      if (updateError) throw new Error(updateError.message);

      const { error: txError } = await supabase
        .from('transactions')
        .insert({
          user_id:            user.id,
          type:               'result',
          credits:            1,
          discord_message_id: message.id,
        });

      if (txError) throw new Error(txError.message);

      await message.react('✅');
      await sendDM(
        message.author,
        `🎉 Bravo **${message.author.username}** ! **+1 crédit** ajouté à ta cagnotte.\n` +
        `💰 Solde actuel : **${user.credits + 1} crédit(s)**\n\n` +
        `Atteins 10 crédits pour demander ton bon Temu de 10€ sur le site !`
      );

      console.log(`✅ +1 crédit attribué à ${message.author.username} (solde: ${user.credits + 1})`);

    } catch (err) {
      console.error(`❌ Erreur salon résultats [${message.author.username}]:`, err.message);
    }
    return;
  }

  // ── Salon témoignages ────────────────────────────────────────────────────────
  if (channelId === CHANNEL_TESTIMONIALS_ID) {
    try {
      const user = await getOrCreateUser(message.member);

      // 1. Vérifier la présence d'une pièce jointe vidéo
      const hasVideo = message.attachments.some((att) => {
        if (!att.contentType) return false;
        return att.contentType.startsWith('video/');
      });

      if (!hasVideo) {
        await message.react('❌');
        await sendDM(
          message.author,
          '❌ Ton témoignage doit contenir une **vidéo** pour être validé.\n' +
          'Enregistre ta vidéo et joins-la directement dans ton message. 🎥'
        );
        console.log(`❌ Pas de vidéo dans le témoignage de ${message.author.username}`);
        return;
      }

      // 2. Vérifier si le bonus a déjà été accordé
      if (user.testimonial_done) {
        await message.react('⏳');
        await sendDM(
          message.author,
          '⏳ Tu as déjà reçu ton bonus témoignage (**+10 crédits**).\n' +
          'Ce bonus est accordé une seule fois par compte. 😊'
        );
        console.log(`⏳ Bonus témoignage déjà accordé à ${message.author.username}`);
        return;
      }

      // 3. Attribuer +10 crédits + marquer testimonial_done
      const { error: updateError } = await supabase
        .from('users')
        .update({
          credits:         user.credits + 10,
          total_earned:    user.total_earned + 10,
          testimonial_done: true,
        })
        .eq('id', user.id);

      if (updateError) throw new Error(updateError.message);

      const { error: txError } = await supabase
        .from('transactions')
        .insert({
          user_id:            user.id,
          type:               'testimonial',
          credits:            10,
          discord_message_id: message.id,
        });

      if (txError) throw new Error(txError.message);

      await message.react('✅');
      await sendDM(
        message.author,
        `🏆 Témoignage validé ! **+10 crédits** offerts, ${message.author.username} !\n` +
        `💰 Solde actuel : **${user.credits + 10} crédit(s)**\n\n` +
        `${user.credits + 10 >= 10
          ? '🎁 Tu peux maintenant demander ton bon Temu de 10€ sur le site !'
          : `Il te manque encore ${10 - (user.credits + 10)} crédit(s) pour demander un retrait.`
        }`
      );

      console.log(`✅ +10 crédits (témoignage) attribués à ${message.author.username} (solde: ${user.credits + 10})`);

    } catch (err) {
      console.error(`❌ Erreur salon témoignages [${message.author.username}]:`, err.message);
    }
    return;
  }
});

// ─── Gestion des erreurs non capturées ───────────────────────────────────────
discord.on(Events.Error, (err) => {
  console.error('❌ Erreur Discord :', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Promesse rejetée :', reason);
});

// ─── Connexion ────────────────────────────────────────────────────────────────
discord.login(process.env.DISCORD_TOKEN);
