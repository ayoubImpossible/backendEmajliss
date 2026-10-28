'use strict';


const { http, asUser } = require('../services/humhub');

function mapUser(u) {
  const account = u.account || {};
  const profile = u.profile || {};
  const tags = account.tags || [];
  return {
    id:          u.id,
    guid:        u.guid,
    display_name: u.display_name,
    username:    account.username,
    email:       account.email,
    prenom_fr:   profile.firstname,
    nom_fr:      profile.lastname,
    titre:       profile.title,
    about:       profile.about,
    phone_work:  profile.phone_work,
    mobile:      profile.mobile,
    image_url:   profile.image_url || null,
    banner_url:  profile.banner_url || null,
    tags,
    commission_fr: tags.find((t) => t.startsWith('CP')) || null,
    categorie_fr:  null,
    last_login:  account.last_login,
  };
}



function directoryForbidden(res) {
  return res.status(403).json({
    error: "L'annuaire général n'est pas ouvert par l'API : HumHub le réserve aux administrateurs.",
    reason: 'humhub_admin_only',
    alternative: '/api/spaces/:id/members',
  });
}

exports.list = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const perPage = Math.min(parseInt(req.query.per_page, 10) || 15, 100);
    const params = { page, limit: perPage };
    if (req.query.search) params.search = req.query.search;

    const { data } = await http.get('/user', {
      params,
      ...(req.humhubToken ? asUser(req.humhubToken) : {}),
      timeout: 10000,
    });

    const results = (data.results || []).map(mapUser);

    res.json({
      data:      results,
      total:     data.total || results.length,
      page,
      per_page:  perPage,
      last_page: data.total ? Math.ceil(data.total / perPage) : 1,
    });
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) return directoryForbidden(res);
    next(err);
  }
};

exports.show = async (req, res, next) => {
  try {
    const { data } = await http.get(`/user/${req.params.id}`, {
      ...(req.humhubToken ? asUser(req.humhubToken) : {}),
      timeout: 8000,
    });
    res.json({ data: mapUser(data) });
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) return directoryForbidden(res);
    if (err.response?.status === 404) return res.status(404).json({ error: 'Membre introuvable' });
    next(err);
  }
};

exports.getGroupes = async (req, res, next) => {
  try {
    const { data } = await http.get('/user/group', {
      ...(req.humhubToken ? asUser(req.humhubToken) : {}),
      timeout: 8000,
    });
    const groups = (data.results || []).map((g) => ({ id: g.id, name: g.name, description: g.description }));
    res.json({ data: { categories: [], commissions: groups.map((g) => g.name), groups } });
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) return directoryForbidden(res);
    next(err);
  }
};

exports.create  = (req, res) => res.status(501).json({ error: 'Non implémenté' });
exports.update  = (req, res) => res.status(501).json({ error: 'Non implémenté' });
exports.destroy = (req, res) => res.status(501).json({ error: 'Non implémenté' });
