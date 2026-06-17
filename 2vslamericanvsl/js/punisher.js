/**
 * PUNISHER — Facebook CAPI Tracker v4.3
 *
 * Toda a CAPI vai server-side via Cloudflare Worker. Zero fbq no browser.
 *
 * SETUP (toda página):
 * ─────────────────────────────────────────────────────────────────────
 *   <script>
 *     const tracker = new Punisher({
 *       workerUrl: 'https://tracker.example.com', // URL do Cloudflare Worker
 *       offerId:   'amsystem',                    // ID da oferta em config.ts no server
 *       debug:     false,                         // true = logs no console
 *     });
 *     tracker.init();
 *   </script>
 *   <script src="https://tracker.example.com/punisher.js" defer></script>
 *
 *
 * PAGEVIEW:
 * ─────────────────────────────────────────────────────────────────────
 *   Disparado automaticamente pelo tracker.init(). Nenhuma config extra necessária.
 *
 *
 * VIEW CONTENT (apenas nas páginas de produto/oferta):
 * ─────────────────────────────────────────────────────────────────────
 *   tracker.init();
 *   tracker.trackViewContent({
 *     contentId:       'amsystem-main', // ID do produto (deve bater com o contentId do checkout)
 *     contentName:     'AM System',     // Nome do produto (aparece nos relatórios do FB)
 *     contentCategory: 'Curso',         // Categoria (opcional)
 *     value:           97,              // Valor em número (não string)
 *     currency:        'BRL',           // Código ISO 4217
 *   });
 *
 *
 * BOTÕES DE CHECKOUT (sempre <a>):
 * ─────────────────────────────────────────────────────────────────────
 *   Existem duas formas de marcar um <a> como checkout:
 *
 *   1) data-checkout-id explícito:
 *      <a data-checkout-id="main">Comprar agora</a>
 *
 *   2) Match por href — passe um mapa checkouts no construtor com checkoutId -> URL.
 *      Qualquer <a> cujo href bata com a URL (ignorando query string) é reconhecido.
 *
 *      new Punisher({
 *        workerUrl: '...',
 *        offerId: '...',
 *        checkouts: {
 *          main: 'https://www.jvzoo.com/b/116329/438089/99',
 *        },
 *      });
 *
 *      <a href="https://www.jvzoo.com/b/116329/438089/99?target=xKqXAwAx5c">Comprar</a>
 *
 *   Em ambos os casos o tracker intercepta o click (capture phase) e redireciona pro /go,
 *   mesmo que outro script reescreva o href depois (ex: script de afiliado JVZoo).
 *
 *   USE SEMPRE <a> — não <button>. Motivos:
 *   1. Funciona com keyboard, screen readers, semântica correta.
 *   2. Middle-click/Ctrl+click ainda navegam pro href atual (best-effort, sem cid).
 *
 *   Bonus: adicione no <head> da página pra browser pré-conectar antes do click:
 *     <link rel="preconnect" href="https://tracker.example.com">
 *
 *
 * OFERTAS:
 * ─────────────────────────────────────────────────────────────────────
 *   offerId identifica a oferta no server (src/data/config.ts).
 *   Cada oferta tem seus próprios pixels e checkouts configurados lá.
 *   O front não precisa saber nada sobre pixels ou tokens.
 */
(() => {
	'use strict';

	const COOKIE_CID = '_tracker_cid';
	const COOKIE_FBC = '_fbc';
	const COOKIE_FBP = '_fbp';
	const COOKIE_TTL_DAYS = 7;

	const getCookie = (name) => {
		const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
		return m ? decodeURIComponent(m[2]) : null;
	};

	const setCookie = (name, value, days = COOKIE_TTL_DAYS) => {
		const exp = new Date(Date.now() + days * 86400_000).toUTCString();
		document.cookie = `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax`;
	};

	const generateCid = () => `cid_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;

	const getOrCreateCid = () => {
		let cid = getCookie(COOKIE_CID);
		if (!cid) {
			cid = generateCid();
			setCookie(COOKIE_CID, cid);
			console.log('[Punisher] cid gerado (novo):', cid);
		} else {
			console.log('[Punisher] cid recuperado do cookie:', cid);
		}
		return cid;
	};

	const getFbp = () => {
		const fbp = getCookie(COOKIE_FBP);
		console.log('[Punisher] _fbp:', fbp ?? '(ausente)');
		return fbp;
	};

	// fbc: cookie _fbc, ou deriva de ?fbclid= e persiste em cookie pra próximas páginas.
	const resolveFbc = (params) => {
		const existing = getCookie(COOKIE_FBC);
		if (existing) {
			console.log('[Punisher] _fbc (cookie):', existing);
			return existing;
		}

		const fbclid = params.get('fbclid');
		if (!fbclid) {
			console.log('[Punisher] _fbc: ausente (sem cookie e sem ?fbclid)');
			return null;
		}

		const fbc = `fb.1.${Date.now()}.${fbclid}`;
		setCookie(COOKIE_FBC, fbc);
		console.log('[Punisher] _fbc gerado de ?fbclid:', fbc);
		return fbc;
	};

	class Punisher {
		constructor(config) {
			if (!config?.workerUrl) throw new Error('Punisher: workerUrl required');
			if (!config?.offerId) throw new Error('Punisher: offerId required');

			this.workerUrl = config.workerUrl.replace(/\/$/, '');
			this.offerId = config.offerId;
			this.debug = config.debug ?? false;
			this.cid = getOrCreateCid();

			// checkouts: { checkoutId: 'https://...' } — usado pra casar <a> por href
			this.checkouts = config.checkouts ?? {};

			// shipwreck: true — lê dados do lead via data-shipwreck-* no elemento clicado
			this.shipwreck = config.shipwreck ?? false;

			// cacheia parsing da URL — evita criar URL/URLSearchParams a cada payload
			const u = new URL(window.location.href);
			this.params = u.searchParams;
			u.searchParams.delete('cid');
			this.cleanUrl = u.toString();

			console.log('[Punisher] init | workerUrl:', this.workerUrl, '| offer:', this.offerId, '| cid:', this.cid);
			console.log('[Punisher] checkouts configurados:', Object.keys(this.checkouts));
			console.log('[Punisher] url limpa:', this.cleanUrl);
			console.log('[Punisher] utm_source:', this.params.get('utm_source'), '| utm_campaign:', this.params.get('utm_campaign'));
		}

		log(...args) {
			if (this.debug) console.log('[Punisher]', ...args);
		}

		basePayload() {
			const p = this.params;
			const payload = {
				cid: this.cid,
				offer_id: this.offerId,
				url: this.cleanUrl,
				fbp: getFbp(),
				fbc: resolveFbc(p),
				referrer: document.referrer || null,
				utm_source: p.get('utm_source'),
				utm_medium: p.get('utm_medium'),
				utm_campaign: p.get('utm_campaign'),
				utm_content: p.get('utm_content'),
				utm_term: p.get('utm_term'),
				sid: p.get('sid'),
				sid1: p.get('sid1'),
				sid2: p.get('sid2'),
				sid3: p.get('sid3'),
			};
			console.log('[Punisher] basePayload:', payload);
			return payload;
		}

		async send(endpoint, body) {
			const fullUrl = `${this.workerUrl}${endpoint}`;
			console.log('[Punisher] POST', fullUrl, body);
			try {
				const res = await fetch(fullUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
					keepalive: true,
				});
				const data = await res.json().catch(() => null);
				if (res.ok) {
					console.log('[Punisher] resposta OK', endpoint, res.status, data);
				} else {
					console.error('[Punisher] resposta com erro', endpoint, res.status, data);
				}
				return data;
			} catch (err) {
				console.error('[Punisher] falha no fetch', endpoint, err);
				return null;
			}
		}

		trackPageView() {
			console.log('[Punisher] disparando PageView');
			return this.send('/track/pageview', this.basePayload());
		}

		trackViewContent({ value, currency, contentName, contentId, contentCategory } = {}) {
			const payload = this.basePayload();
			if (typeof value === 'number') payload.value = value;
			if (currency) payload.currency = currency;
			if (contentName) payload.content_name = contentName;
			if (contentId) payload.content_id = contentId;
			if (contentCategory) payload.content_category = contentCategory;
			console.log('[Punisher] disparando ViewContent', { contentId, contentName, value, currency });
			return this.send('/track/viewcontent', payload);
		}

		buildGoUrl(checkoutId, extraParams) {
			const url = new URL(`${this.workerUrl}/go/${encodeURIComponent(this.offerId)}/${encodeURIComponent(checkoutId)}`);
			url.searchParams.set('cid', this.cid);
			if (extraParams) {
				new URLSearchParams(extraParams).forEach((v, k) => {
					if (k !== 'cid') url.searchParams.set(k, v);
				});
			}
			return url.toString();
		}

		// Normaliza URL pra origin+pathname (ignora query/hash) — usado no match por href.
		normalizeUrl(raw) {
			try {
				const u = new URL(raw, window.location.href);
				return (u.origin + u.pathname).replace(/\/$/, '');
			} catch {
				return null;
			}
		}

		// Extrai a query string do href do <a> (target, sids do afiliado, etc.).
		// Esses params têm prioridade sobre os da página porque vêm embutidos no botão específico.
		extractHrefParams(el) {
			const raw = el.getAttribute('href');
			if (!raw) return new URLSearchParams();
			try {
				const u = new URL(raw, window.location.href);
				console.log('[Punisher] href params:', u.searchParams.toString() || '(none)');
				return u.searchParams;
			} catch {
				return new URLSearchParams();
			}
		}

		// Lê data-shipwreck-{email,first-name,last-name} do elemento e retorna URLSearchParams.
		extractShipwreckParams(el) {
			const p = new URLSearchParams();
			const email = el.getAttribute('data-shipwreck-email');
			const firstName = el.getAttribute('data-shipwreck-first-name');
			const lastName = el.getAttribute('data-shipwreck-last-name');
			if (email) p.set('email', email);
			if (firstName) p.set('first_name', firstName);
			if (lastName) p.set('last_name', lastName);
			console.log('[Punisher] shipwreck params:', { email, first_name: firstName, last_name: lastName });
			return p;
		}

		// Constrói índice {urlNormalizada -> checkoutId} a partir de config.checkouts.
		buildCheckoutIndex() {
			const byTarget = new Map();
			Object.entries(this.checkouts).forEach(([id, url]) => {
				const norm = this.normalizeUrl(url);
				if (norm) {
					byTarget.set(norm, id);
					console.log('[Punisher] checkout indexado:', id, '->', norm);
				} else {
					console.warn('[Punisher] checkout com URL inválida ignorado:', id, url);
				}
			});
			return byTarget;
		}

		// Dado um <a>, descobre o checkoutId. data-checkout-id ganha; senão tenta match por href.
		resolveCheckoutId(el, byTarget) {
			const explicit = el.getAttribute('data-checkout-id');
			if (explicit) {
				console.log('[Punisher] checkout resolvido via data-checkout-id:', explicit, el);
				return explicit;
			}
			const rawHref = el.getAttribute('href');
			if (!rawHref) return null;
			const norm = this.normalizeUrl(rawHref);
			if (!norm) return null;
			const id = byTarget.get(norm) ?? null;
			if (id) {
				console.log('[Punisher] checkout resolvido via match de href:', id, rawHref);
			}
			return id;
		}

		// Aplica estado de loading visual nos botões de checkout e bloqueia novos clicks.
		// Apenas estilos — não altera comportamento de navegação.
		applyLoadingState(clicked, allCheckoutEls) {
			if (!document.getElementById('_punisher_spinner_style')) {
				const style = document.createElement('style');
				style.id = '_punisher_spinner_style';
				style.textContent =
					'@keyframes _punisher_spin { to { transform: rotate(360deg); } }' +
					'._punisher_spinner { animation: _punisher_spin 0.8s linear infinite; display: block; }';
				document.head.appendChild(style);
			}

			allCheckoutEls.forEach((other) => {
				other.style.pointerEvents = 'none';
				other.setAttribute('aria-disabled', 'true');
				other.style.opacity = '0.5';
			});

			clicked.innerHTML =
				'<span style="display:inline-flex;align-items:center;justify-content:center;gap:8px;">' +
				'<svg class="_punisher_spinner" viewBox="0 0 50 50" width="24" height="24">' +
				'<circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="90, 150" stroke-linecap="round"></circle>' +
				'</svg>' +
				'<span>Validating...</span>' +
				'</span>';
		}

		// Coleta todos os <a> que são checkouts (data-checkout-id ou href que bate com o índice).
		findCheckoutElements(byTarget) {
			return Array.from(document.querySelectorAll('a[href]')).filter((a) => this.resolveCheckoutId(a, byTarget) !== null);
		}

		// Click delegate em capture phase: garante que o redirect /go/... acontece mesmo se
		// outro script (JVZoo affiliate, etc.) reescrever o href via MutationObserver.
		// Não bloqueia middle-click/Ctrl+click — esses vão pro href atual (best-effort).
		attachClickDelegate() {
			const byTarget = this.buildCheckoutIndex();
			let locked = false;

			document.addEventListener('click', (ev) => {
				if (ev.button !== 0) return; // só left-click
				if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

				const a = ev.target.closest && ev.target.closest('a[href]');
				if (!a) return;

				const id = this.resolveCheckoutId(a, byTarget);
				if (!id) return;

				if (locked) {
					ev.preventDefault();
					return;
				}

				if (ev.defaultPrevented) return;

				locked = true;

				// Monta params em camadas (cada uma sobrescreve a anterior):
				// 1. página atual (utms, fbclid, sid3 vindos do tráfego)
				// 2. href do <a> (target/sid do afiliado embutidos no botão — prioridade sobre a página)
				// 3. shipwreck (se flag ativa)
				const merged = new URLSearchParams(this.params.toString());
				merged.delete('cid');
				const hrefParams = this.extractHrefParams(a);
				hrefParams.forEach((v, k) => {
					if (k !== 'cid') merged.set(k, v);
				});
				if (this.shipwreck) {
					this.extractShipwreckParams(a).forEach((v, k) => merged.set(k, v));
				}
				const extra = merged.toString() || null;
				const goUrl = this.buildGoUrl(id, extra);

				this.applyLoadingState(a, this.findCheckoutElements(byTarget));

				ev.preventDefault();
				console.log('[Punisher] click de checkout interceptado | id:', id, '| extra params:', extra, '| goUrl:', goUrl);
				window.location.href = goUrl;
			}, true); // capture: roda antes de handlers do JVZoo
		}

		// Dispara PageView (fire-and-forget) e prepara links de checkout.
		init() {
			console.log('[Punisher] init() chamado');
			this.trackPageView();

			if (this.params.has('cid')) {
				try {
					const u = new URL(window.location.href);
					u.searchParams.delete('cid');
					window.history.replaceState(null, '', u);
					console.log('[Punisher] ?cid removido da URL via replaceState');
				} catch (err) {
					console.warn('[Punisher] falha ao limpar ?cid da URL:', err);
				}
			}

			this.attachClickDelegate();
			console.log('[Punisher] pronto');
		}
	}

	window.Punisher = Punisher;
})();
