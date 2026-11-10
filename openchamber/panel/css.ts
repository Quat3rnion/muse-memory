// Panel styles. Only host theme tokens (--oc-*) set colour, font and radius.
export const CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--oc-bg);color:var(--oc-fg);font-family:var(--oc-font);font-size:14px;line-height:1.5}
button{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--oc-focus);outline-offset:1px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.app{height:100%;display:flex;flex-direction:column;min-width:0}

/* Header: title, counts and run times on one calm line that wraps when narrow. */
.head{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px 20px;padding:12px 16px 10px}
.head h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}
.counts{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0;padding:0;list-style:none;font-size:12px;color:var(--oc-muted)}
.counts b{color:var(--oc-fg);font-weight:600;font-variant-numeric:tabular-nums;margin-right:4px}
.counts .warn b{color:var(--oc-warning-text)}
.app[data-layout=narrow] .counts{order:3;width:100%}
.runs{margin-left:auto;flex:1 1 auto;min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:10px;font-size:12px;color:var(--oc-muted)}
.runs span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.icon-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;border-radius:calc(var(--oc-radius,8px) - 2px);background:transparent;color:var(--oc-muted);cursor:pointer;flex:none}
.icon-btn:hover{background:var(--oc-hover);color:var(--oc-fg)}
.icon-btn:disabled{opacity:.5;cursor:default}
.icon-btn svg{width:16px;height:16px;fill:currentColor}
.icon-btn.spin svg{animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.tabs{flex:none;padding:0 16px 10px;border-bottom:1px solid var(--oc-border)}
.banners{flex:none;display:flex;flex-direction:column;gap:6px;padding:8px 16px 0}
.banners:empty{display:none}
.view{flex:1;min-height:0;display:flex;min-width:0}
.view[hidden]{display:none}

/* Two-pane layouts. */
.split{flex:1;min-width:0;display:grid;grid-template-columns:minmax(320px,42%) minmax(0,1fr)}
.pane{min-width:0;min-height:0;display:flex;flex-direction:column}
.pane.list-pane{border-right:1px solid var(--oc-border);background:var(--oc-elevated)}
.app[data-layout=narrow] .split{grid-template-columns:100%}
.app[data-layout=narrow] .split[data-pane=list] .detail-pane{display:none}
.app[data-layout=narrow] .split[data-pane=detail] .list-pane{display:none}
.app[data-layout=narrow] .pane.list-pane{border-right:none}
.back{display:none}
.app[data-layout=narrow] .back{display:inline-flex}
.back-btn{align-items:center;gap:6px;height:28px;padding:0 8px 0 4px;margin:0 0 12px -4px;border:none;border-radius:calc(var(--oc-radius,8px) - 2px);background:transparent;color:var(--oc-muted);cursor:pointer;font-size:13px}
.back-btn:hover{background:var(--oc-hover);color:var(--oc-fg)}
.back-btn svg{width:16px;height:16px;fill:currentColor}
.doc-title{font-size:18px;margin:0 0 4px;font-weight:600}
.nav-note{padding:4px 16px;font-size:12px;color:var(--oc-muted)}

.filters{flex:none;display:flex;flex-direction:column;gap:10px;padding:12px;border-bottom:1px solid var(--oc-border)}
.search-row{display:flex;gap:8px;align-items:center}
.search-row > div:first-child{flex:1;min-width:0}
.filter-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px;align-items:end}
.filter-row .oc-sdk-trigger{align-self:stretch;justify-content:space-between}
.filter-foot{display:flex;align-items:center;gap:10px;justify-content:space-between;flex-wrap:wrap;min-height:28px}
.text-btn{border:none;background:transparent;color:var(--oc-muted);cursor:pointer;font-size:12px;padding:4px 6px;border-radius:6px}
.text-btn:hover{color:var(--oc-fg);background:var(--oc-hover)}
.text-btn[hidden]{display:none}
.filters-toggle{display:none;align-items:center;gap:6px;height:32px;padding:0 10px;border:1px solid var(--oc-border);border-radius:calc(var(--oc-radius,8px) - 2px);background:transparent;cursor:pointer;font-size:13px;white-space:nowrap}
.filters-toggle:hover{background:var(--oc-hover)}
.filters-toggle b{font-weight:600;color:var(--oc-primary-text)}
.app[data-layout=narrow] .filters-toggle{display:inline-flex}
.app[data-layout=narrow] .filters:not([data-open=true]) .filter-row,.app[data-layout=narrow] .filters:not([data-open=true]) .filter-foot{display:none}
.result-line{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12px;color:var(--oc-muted);border-bottom:1px solid var(--oc-border)}
.result-line .grow{flex:1}
.scroll{flex:1;min-height:0;overflow-y:auto}
.rows{list-style:none;margin:0;padding:4px 0}
.row{display:flex;flex-direction:column;gap:4px;width:calc(100% - 12px);margin:1px 6px;padding:8px 10px;border:none;border-radius:calc(var(--oc-radius,8px) - 2px);background:transparent;text-align:left;cursor:pointer;min-width:0}
.row:hover{background:var(--oc-hover)}
.row[aria-current=true]{background:var(--oc-selection);color:var(--oc-selection-fg)}
.row-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.row[data-status=retracted] .row-text,.row[data-status=superseded] .row-text{color:var(--oc-muted)}
.row-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--oc-muted);min-width:0}
.row[aria-current=true] .row-meta{color:inherit;opacity:.8}
.row[aria-current=true] .meter i{background:color-mix(in srgb,currentColor 25%,transparent)}
.row[aria-current=true] .meter i::after{background:currentColor}
.pin{display:inline-flex;color:var(--oc-primary-text)}
.pin svg{width:13px;height:13px;fill:currentColor}
.meter{display:inline-flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums}
.meter i{display:inline-block;width:34px;height:4px;border-radius:2px;background:var(--oc-border);overflow:hidden;position:relative}
.meter i::after{content:"";position:absolute;inset:0;width:var(--v);background:var(--oc-muted)}
.pager{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--oc-border);font-size:12px;color:var(--oc-muted)}
.pager .grow{flex:1}
.state{padding:24px 16px;display:flex;justify-content:center}

/* Detail. */
.detail{padding:20px 24px 32px;max-width:820px;width:100%}
.detail-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.detail-top .id{margin-left:auto;font-family:var(--oc-mono);font-size:12px;color:var(--oc-muted)}
.claim-text{margin:0 0 14px;font-size:16px;line-height:1.5;overflow-wrap:anywhere}
.claim-text.gone{color:var(--oc-muted);font-style:italic}
.metrics{display:flex;gap:8px 24px;flex-wrap:wrap;margin-bottom:14px;font-size:12px;color:var(--oc-muted)}
.metrics .meter i{width:80px;height:6px;border-radius:3px}
.metrics .meter i::after{background:var(--oc-primary)}
.metrics .meter b{color:var(--oc-fg);font-weight:600}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding-bottom:16px;border-bottom:1px solid var(--oc-border);margin-bottom:4px}
.actions .push{margin-left:auto}
.section{padding:16px 0 4px}
.section h2{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--oc-muted)}
.quote{margin:0;padding:8px 12px;border-left:3px solid var(--oc-border);background:var(--oc-muted-surface);border-radius:0 calc(var(--oc-radius,8px) - 2px) calc(var(--oc-radius,8px) - 2px) 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
.evidence{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.evidence li{padding:10px 12px;border:1px solid var(--oc-border);border-radius:var(--oc-radius,8px)}
.ev-head{display:flex;align-items:flex-start;gap:8px;margin-bottom:6px}
.ev-title{flex:1;min-width:0}
.ev-title b{display:block;font-weight:600;font-size:13px;overflow-wrap:anywhere}
.mono{font-family:var(--oc-mono);font-size:11.5px;color:var(--oc-muted);overflow-wrap:anywhere}
.ev-quote{font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:2px 10px;border:1px solid var(--oc-border);border-radius:999px;background:transparent;cursor:pointer}
.chip:hover{background:var(--oc-hover)}
.chip small{color:var(--oc-muted);font-size:11px}
.record{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 16px;margin:0;font-size:13px}
.record dt{color:var(--oc-muted)}
.record dd{margin:0;overflow-wrap:anywhere}
.chain{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.chain li{display:flex;gap:8px;align-items:baseline;font-size:13px}
.link{border:none;background:none;padding:0;color:var(--oc-primary-text);cursor:pointer;text-decoration:underline;text-underline-offset:2px;text-decoration-color:color-mix(in srgb,var(--oc-primary-text) 40%,transparent);text-align:left;font:inherit}
.link:hover{text-decoration-color:currentColor}
.link.mono{font-family:var(--oc-mono);font-size:12px;color:var(--oc-primary-text)}
.muted{color:var(--oc-muted)}

/* Edit form. */
.edit{display:flex;flex-direction:column;gap:12px;margin-bottom:16px}
.edit-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;align-items:end}
.edit-row .oc-sdk-trigger{align-self:stretch;justify-content:space-between}
.range{display:flex;flex-direction:column;gap:4px;font-size:12px}
.range label{color:var(--oc-muted);display:flex;justify-content:space-between}
.range output{color:var(--oc-fg);font-variant-numeric:tabular-nums;font-weight:600}
.range input{width:100%;accent-color:var(--oc-primary)}
.form-error{color:var(--oc-error-text);font-size:12px}
.form-error:empty{display:none}

/* Legacy list. */
.page{flex:1;min-width:0;overflow-y:auto}
.page-inner{max-width:900px;margin:0 auto;padding:16px 16px 32px}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.toolbar .oc-sdk-search{flex:1;min-width:200px}
.lead{margin:0 0 12px;font-size:13px;color:var(--oc-muted)}
.cards{list-style:none;margin:0;padding:0;border-top:1px solid var(--oc-border)}
.card{display:flex;gap:12px;align-items:flex-start;padding:12px 4px;border-bottom:1px solid var(--oc-border)}
.card-main{flex:1;min-width:0}
.card-text{margin:0 0 6px;overflow-wrap:anywhere}
.labels{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11.5px;color:var(--oc-muted)}
.labels span b{font-weight:500;color:var(--oc-fg);opacity:.85}
.card-actions{display:flex;gap:6px;flex:none}
.app[data-layout=narrow] .card{flex-direction:column}

/* Dreams. */
.dreams{flex:1;min-width:0;display:grid;grid-template-columns:200px minmax(0,1fr)}
.nav{border-right:1px solid var(--oc-border);background:var(--oc-elevated);overflow-y:auto;padding:8px 0}
.nav h2{margin:12px 16px 4px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--oc-muted)}
.nav .row{flex-direction:row;align-items:center;padding:6px 10px}
.nav .row .grow{flex:1}
.app[data-layout=narrow] .dreams{grid-template-columns:100%;grid-template-rows:auto minmax(0,1fr)}
.app[data-layout=narrow] .nav{border-right:none;border-bottom:1px solid var(--oc-border);display:flex;overflow-x:auto;padding:6px}
.app[data-layout=narrow] .nav h2{display:none}
.app[data-layout=narrow] .nav .row{width:auto;flex:none;margin:0 2px}
.doc{overflow-y:auto;min-width:0}
.doc-inner{max-width:780px;padding:20px 28px 40px}
.md{overflow-wrap:anywhere}
.md h2{font-size:18px;margin:0 0 10px;font-weight:600}
.md h3{font-size:14px;margin:22px 0 6px;font-weight:600}
.md h4,.md h5,.md h6{font-size:13px;margin:16px 0 4px;font-weight:600}
.md p{margin:0 0 10px}
.md ul,.md ol{margin:0 0 10px;padding-left:20px}
.md li{margin:3px 0}
.md code{font-family:var(--oc-mono);font-size:12px;background:var(--oc-muted-surface);padding:1px 4px;border-radius:4px}
.md pre{font-family:var(--oc-mono);font-size:12px;background:var(--oc-muted-surface);padding:10px 12px;border-radius:var(--oc-radius,8px);overflow-x:auto;white-space:pre}
.md blockquote{margin:0 0 10px;padding:2px 12px;border-left:3px solid var(--oc-border);color:var(--oc-muted)}
.md hr{border:none;border-top:1px solid var(--oc-border);margin:16px 0}
.md a{color:var(--oc-primary-text)}
.md-meta{display:flex;flex-wrap:wrap;gap:2px 8px;margin:0 0 14px;font-size:12px;color:var(--oc-muted)}
.md-meta dt::after{content:":"}
.md-meta dd{margin:0 10px 0 0;color:var(--oc-fg)}
.claim-ref{border:none;background:color-mix(in srgb,var(--oc-primary) 12%,transparent);color:var(--oc-primary-text);font-family:var(--oc-mono);font-size:11px;padding:0 5px;border-radius:4px;cursor:pointer;vertical-align:baseline}
.claim-ref:hover{background:color-mix(in srgb,var(--oc-primary) 24%,transparent)}
.threads{list-style:none;margin:0 0 8px;padding:0;display:flex;flex-direction:column;gap:10px}
.thread{padding:12px 14px;border:1px solid var(--oc-border);border-radius:var(--oc-radius,8px)}
.thread[data-open=true]{border-left:3px solid var(--oc-warning)}
.thread-head{display:flex;gap:8px;align-items:flex-start;margin-bottom:6px}
.thread-head b{flex:1;font-weight:600;overflow-wrap:anywhere}
.thread p{margin:4px 0 0;font-size:13px;overflow-wrap:anywhere}
.thread .k{color:var(--oc-muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin-right:6px}
.timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.timeline li{display:grid;grid-template-columns:96px minmax(0,1fr);gap:12px;font-size:13px}
.timeline time{color:var(--oc-muted);font-variant-numeric:tabular-nums}
.doc .section h2{font-size:12px}
.doc .section ul{margin:0;padding-left:20px;font-size:13px}
.doc .section li{margin:3px 0}
.doc .section ul.threads,.doc .section ol.timeline{padding-left:0}
.app[data-layout=narrow] .doc-inner{padding:16px 16px 32px}
.app[data-layout=narrow] .detail{padding:12px 16px 32px}
.doc .section p{margin:0 0 6px;font-size:13px}

/* Pinned. */
.pinned-editor{display:flex;flex-direction:column;gap:8px}
.pinned-editor textarea{min-height:200px;resize:vertical;width:100%;padding:10px 12px;background:var(--oc-bg);color:var(--oc-fg);border:1px solid var(--oc-border);border-radius:var(--oc-radius,8px);font-family:var(--oc-mono);font-size:12.5px;line-height:1.5}
.pinned-editor textarea:focus-visible{outline:2px solid var(--oc-focus);outline-offset:-1px}
.editor-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.editor-foot .count{margin-right:auto;font-size:12px;color:var(--oc-muted);font-variant-numeric:tabular-nums}
.editor-foot .count.over{color:var(--oc-error-text)}

/* Dialog. */
dialog{border:1px solid var(--oc-border);border-radius:calc(var(--oc-radius,8px) + 4px);background:var(--oc-elevated);color:var(--oc-fg);padding:0;width:min(480px,calc(100% - 32px));box-shadow:0 18px 48px rgba(0,0,0,.35)}
dialog::backdrop{background:rgba(0,0,0,.45)}
.dlg{display:flex;flex-direction:column;gap:12px;padding:18px 20px}
.dlg h2{margin:0;font-size:16px;font-weight:600}
.dlg p{margin:0;font-size:13px;color:var(--oc-muted)}
.dlg blockquote{margin:0;padding:8px 12px;border-left:3px solid var(--oc-border);background:var(--oc-muted-surface);font-size:13px;overflow-wrap:anywhere;max-height:140px;overflow-y:auto}
.dlg-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:4px}
.select-native{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--oc-muted)}

@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;
