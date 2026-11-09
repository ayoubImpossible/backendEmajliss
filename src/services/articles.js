'use strict';

/**
 * Articles du Journal — route HumHub /emajlis/article/{type}/{id}
 * (module emajlisApi, ArticleController, ajoutée le 09/11/2026).
 *
 *   type = import   → ImportArticle (module import-article)
 *   type = majliss  → MajlissPost   (module external-html-stream)
 *   id   = metadata.object_id de l'élément du fil
 *
 * Toujours avec le jeton de l'utilisateur : HumHub applique ses droits
 * (Content::canView), 403 sinon.
 */

const { http, asUser } = require('./humhub');
const { cleanHtml, plain } = require('./wordpress');

/** Type d'article HumHub d'après le modèle de l'objet, sinon null. */
function articleType(objectModel) {
  const m = String(objectModel || '');
  if (/import_article\\models\\ImportArticle$/.test(m)) return 'import';
  if (/externalHtmlStream\\models\\MajlissPost$/.test(m)) return 'majliss';
  return null;
}

function firstImage(html) {
  const m = String(html || '').match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  return m ? m[1] : null;
}

/**
 * @returns {Promise<{title, date, imageUrl, html, excerpt, isRtl, webUrl, originalLink}>}
 */
async function get(token, type, id) {
  const { data } = await http.get(`/emajlis/article/${type}/${encodeURIComponent(id)}`, {
    ...asUser(token),
    timeout: 20000,
  });
  const html = cleanHtml(String(data?.contentHtml || ''));
  return {
    title: plain(data?.title || '') || 'Article',
    date: data?.date || null,
    imageUrl: data?.imageUrl || firstImage(html),
    html,
    excerpt: plain(html).slice(0, 220),
    isRtl: data?.isRtl ?? null,
    webUrl: data?.webUrl || null,
    originalLink: data?.originalLink || null,
  };
}

module.exports = { articleType, get };
