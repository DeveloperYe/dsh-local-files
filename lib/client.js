/**
 * dsh-local-files — client half.
 *
 * Adds the missing "download to my machine" exit to the right Sidebar document
 * preview, a shortcut from the workspace file tree to the full local file
 * browser page (/-/files), and a repair for file links whose relative path
 * contains a `..` segment (see `normalizeFileAddress`).
 *
 * Plain JS: client modules are loaded through window.__ModuleLoader__
 * (CommonJS closure factory), which tsc cannot emit.
 */
window.__ModuleLoader__.load({
  id: "dsh-local-files",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");

    /** Same-origin download endpoint owned by the host half. */
    function downloadHref(absolutePath) {
      return "/-/files/api/download?path=" + encodeURIComponent(absolutePath);
    }

    /** Full file browser page, opened at the given directory. */
    function browserHref(absolutePath) {
      return "/-/files?path=" + encodeURIComponent(absolutePath);
    }

    var linkStyle = {
      display: "inline-flex",
      alignItems: "center",
      height: 26,
      padding: "0 10px",
      borderRadius: 8,
      border: "1px solid var(--dsw-alias-border-l2, #444)",
      background: "transparent",
      color: "var(--dsw-alias-label-primary, #eee)",
      fontSize: 12,
      textDecoration: "none",
      whiteSpace: "nowrap",
      cursor: "pointer"
    };

    var primaryStyle = Object.assign({}, linkStyle, {
      background: "var(--dsw-alias-label-primary, #eee)",
      color: "var(--dsw-alias-bg-layer-3, #111)",
      borderColor: "transparent"
    });

    var wrapStyle = {
      display: "inline-flex",
      alignItems: "center",
      gap: 6
    };

    function DownloadLink(props) {
      var path = props && props.absolutePath;
      if (typeof path !== "string" || path.length === 0) return null;
      return react.createElement(
        "a",
        {
          href: downloadHref(path),
          download: "",
          title: "下载到本机",
          style: linkStyle,
          onClick: function (event) { event.stopPropagation(); }
        },
        "下载"
      );
    }

    /** Preview header action: one click download of the file being previewed. */
    function DocumentDownloadAction(props) {
      var path = props && props.absolutePath;
      if (typeof path !== "string" || path.length === 0) return null;
      return react.createElement("span", { style: wrapStyle }, react.createElement(DownloadLink, props));
    }

    /** Unpreviewable empty state: download plus a jump into the file browser. */
    function UnpreviewableAction(props) {
      var path = props && props.absolutePath;
      if (typeof path !== "string" || path.length === 0) return null;
      return react.createElement(
        "span",
        { style: Object.assign({}, wrapStyle, { justifyContent: "center" }) },
        react.createElement(
          "a",
          { href: downloadHref(path), download: "", style: primaryStyle, title: "下载到本机" },
          "下载到本机"
        ),
        react.createElement(
          "a",
          {
            href: browserHref(path),
            target: "_blank",
            rel: "noreferrer",
            style: linkStyle,
            title: "在本地文件管理器中打开"
          },
          "文件管理器"
        )
      );
    }

    /** Files tab header action: open the whole-disk browser at this directory. */
    function FilesTabAction(props) {
      var path = props && props.absolutePath;
      if (typeof path !== "string" || path.length === 0) return null;
      return react.createElement(
        "a",
        {
          href: browserHref(path),
          target: "_blank",
          rel: "noreferrer",
          style: linkStyle,
          title: "浏览本机任意目录并下载文件"
        },
        "文件管理器"
      );
    }

    // ── file address repair ────────────────────────────────────────────────
    //
    // Clicking a file link in chat builds `dsh-resource://file/session/<id>/<the
    // relative path, verbatim>`. The Sidebar decides who opens an address by
    // globbing it (`dsh-resource://file/**`) with picomatch, and picomatch's
    // `**` never matches a `..` segment - so a link written as
    // `../notes/x.md` (or any path that walks up first) claims no tab type and
    // the registry throws `sidebarRight: no registered tab type claims "..."`.
    //
    // Wrapping the two `sidebarRight` entry points to resolve `.`/`..` first
    // keeps the fix inside a plugin: nothing under node_modules is touched, so
    // upgrading DSH cannot drop it.

    var FILE_PREFIX = "dsh-resource://file/";

    function decodeSegment(segment) {
      try {
        return decodeURIComponent(segment);
      } catch (error) {
        return segment;
      }
    }

    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ":");
    }

    function isAbsolutePath(path) {
      // A bare drive segment ("C:") counts too: addresses arrive split on "/".
      return /^[A-Za-z]:(?:[\\/]|$)/.test(path) || path.charAt(0) === "/";
    }

    function toParts(path) {
      return String(path).replace(/\\/g, "/").split("/").filter(function (part) { return part !== ""; });
    }

    function splitSuffix(body) {
      var index = body.search(/[?#]/);
      return index === -1 ? [body, ""] : [body.slice(0, index), body.slice(index)];
    }

    function hasDotDot(segments) {
      for (var i = 0; i < segments.length; i += 1) if (decodeSegment(segments[i]) === "..") return true;
      return false;
    }

    /** Collapse `.`/`..` segments; with a workspace root, also rewrite to a root-relative path when possible. */
    function resolveSegments(rootPath, segments) {
      var rootParts = typeof rootPath === "string" && isAbsolutePath(rootPath) ? toParts(rootPath) : [];
      var parts = rootParts.slice();
      for (var i = 0; i < segments.length; i += 1) {
        var segment = segments[i];
        if (segment === "" || segment === ".") continue;
        if (segment === "..") { parts.pop(); continue; }
        parts.push(segment);
      }
      if (rootParts.length === 0) return { absolute: false, parts: parts };
      var shared = 0;
      while (shared < rootParts.length && shared < parts.length && rootParts[shared].toLowerCase() === parts[shared].toLowerCase()) shared += 1;
      if (shared === rootParts.length) return { absolute: false, parts: parts.slice(shared) };
      return { absolute: true, parts: parts };
    }

    function joinSegments(resolved) {
      var body = resolved.parts.map(encodeSegment).join("/");
      if (!resolved.absolute) return body;
      var drive = resolved.parts.length > 0 && /^[A-Za-z]:$/.test(resolved.parts[0]);
      return (drive ? "" : "/") + body;
    }

    /** Session id carried by a `dsh-resource://file/session/<id>/...` address, or "". */
    function sessionIdOf(address) {
      var match = /^dsh-resource:\/\/file\/session\/([^/?#]+)/.exec(String(address));
      return match === null ? "" : decodeSegment(match[1]);
    }

    /**
     * Kill `..` segments in a file address so the Sidebar's glob can claim it.
     *
     * With `cwd`, a path that stays inside the workspace becomes workspace
     * relative (the preview then reads the intended file); a path that walks
     * out of it becomes absolute inside the same session scope (still
     * claimable - the preview reports that it cannot read it, instead of the
     * tab registry throwing). Without `cwd`, `.`/`..` are collapsed as far as
     * the segments alone allow, which at least keeps the link clickable.
     *
     * @param address - a `dsh-resource://file/...` address.
     * @param cwd - the Session workspace root, when known.
     * @returns the repaired address, or the input untouched when nothing applies.
     */
    function normalizeFileAddress(address, cwd) {
      if (typeof address !== "string" || address.indexOf(FILE_PREFIX) !== 0) return address;
      var split = splitSuffix(address.slice(FILE_PREFIX.length));
      var head = split[0];
      var suffix = split[1];
      var parts = head.split("/");
      var scope = parts.shift();
      if (scope === "session") {
        var id = parts.shift();
        if (id === undefined || !hasDotDot(parts)) return address;
        var resolved = resolveSegments(cwd, parts.map(decodeSegment));
        return FILE_PREFIX + "session/" + id + "/" + joinSegments(resolved) + suffix;
      }
      if (scope === "absolute") {
        if (!hasDotDot(parts)) return address;
        var unc = parts.length > 1 && parts[0] === "";
        var resolvedAbsolute = resolveSegments("", (unc ? parts.slice(1) : parts).map(decodeSegment));
        var prefix = unc ? "/" : (resolvedAbsolute.parts.length > 0 && /^[A-Za-z]:$/.test(resolvedAbsolute.parts[0]) ? "" : "/");
        return FILE_PREFIX + "absolute/" + prefix + resolvedAbsolute.parts.map(encodeSegment).join("/") + suffix;
      }
      return address;
    }

    /** Decode every segment and split on both separators, so `a\b` becomes two segments. */
    function expandSegments(rawSegments) {
      var out = [];
      for (var i = 0; i < rawSegments.length; i += 1) {
        var pieces = decodeSegment(rawSegments[i]).replace(/\\/g, "/").split("/");
        for (var j = 0; j < pieces.length; j += 1) out.push(pieces[j]);
      }
      return out;
    }

    /**
     * Extension-less last segment reads as a directory: the chat renderer drops
     * the trailing slash, so `deliverables/` arrives as `deliverables`.
     */
    function looksLikeDirectory(segments) {
      if (segments.length === 0) return false;
      var last = segments[segments.length - 1];
      if (last === "" || last === "." || last === "..") return true;
      return last.lastIndexOf(".") < 0;
    }

    /** Native spelling for the file-manager page (`C:\a\b` on Windows, `/a/b` elsewhere). */
    function nativePath(parts) {
      var drive = parts.length > 0 && /^[A-Za-z]:$/.test(parts[0]);
      return parts.join(drive ? "\\" : "/");
    }

    /** Resolve `.`/`..` onto a base; `escaped` marks a `..` that walked above the base. */
    function walkSegments(baseParts, segments) {
      var parts = baseParts.slice();
      var escaped = false;
      for (var i = 0; i < segments.length; i += 1) {
        var segment = segments[i];
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
          if (parts.length === 0) escaped = true;
          else parts.pop();
          continue;
        }
        parts.push(segment);
      }
      return { parts: parts, escaped: escaped };
    }

    /** Case-insensitive prefix test over already-split path segments. */
    function startsWithParts(parts, prefix) {
      if (parts.length < prefix.length) return false;
      for (var i = 0; i < prefix.length; i += 1) {
        if (parts[i].toLowerCase() !== prefix[i].toLowerCase()) return false;
      }
      return true;
    }

    function absoluteParts(cwd, relativeParts) {
      return toParts(typeof cwd === "string" ? cwd : "").concat(relativeParts);
    }

    /**
     * Decide how to open a file address, so clicking a file block always lands somewhere useful.
     *
     * - inside the session workspace -> a repaired `session`-scoped address (the document tab opens it)
     * - outside it, absolute, or a directory -> the local file-manager page, which can read anything
     *
     * @param address - a `dsh-resource://file/...` address (or anything else, passed through).
     * @param cwd - the Session workspace root, when known.
     * @returns `{ action: "open", address }` or `{ action: "browser", path }`.
     */
    function planFileOpen(address, cwd) {
      if (typeof address !== "string" || address.indexOf(FILE_PREFIX) !== 0) return { action: "open", address: address };
      var split = splitSuffix(address.slice(FILE_PREFIX.length));
      var parts = split[0].split("/");
      var suffix = split[1];
      var scope = parts.shift();
      var trailingSlash = parts.length > 0 && parts[parts.length - 1] === "";
      var segments = expandSegments(parts);

      if (scope === "session") {
        var id = segments.length > 0 ? segments[0] : undefined;
        var rest = segments.slice(1);
        if (id === undefined || id === "") return { action: "open", address: address };
        if (typeof cwd !== "string" || cwd === "") {
          // No workspace root to resolve against: keep the legacy best effort.
          return { action: "open", address: FILE_PREFIX + "session/" + encodeSegment(id) + "/" + joinSegments(resolveSegments("", rest)) + suffix };
        }
        var rootParts = toParts(cwd);
        var absoluteRest = rest.length > 0 && isAbsolutePath(rest[0]);
        var walked = walkSegments(absoluteRest ? [] : rootParts, rest);
        var target = walked.parts;
        var inside = startsWithParts(target, rootParts) && (absoluteRest || !walked.escaped);
        var directory = trailingSlash || rest.length === 0 || looksLikeDirectory(rest);
        if (!inside || directory) {
          if (target.length === 0) return { action: "open", address: address };
          return { action: "browser", path: nativePath(target) };
        }
        return {
          action: "open",
          address: FILE_PREFIX + "session/" + encodeSegment(id) + "/" + target.slice(rootParts.length).map(encodeSegment).join("/") + suffix,
        };
      }

      if (scope === "absolute") {
        var unc = segments.length > 1 && segments[0] === "";
        var absolute = unc ? ["", ""].concat(segments.slice(1)) : segments;
        var resolvedAbsolute = resolveSegments("", absolute.filter(function (part) { return part !== "" || unc; }));
        if (trailingSlash || looksLikeDirectory(absolute)) return { action: "browser", path: nativePath(resolvedAbsolute.parts) };
        return { action: "open", address: FILE_PREFIX + "absolute/" + (unc ? "/" : (resolvedAbsolute.parts.length > 0 && /^[A-Za-z]:$/.test(resolvedAbsolute.parts[0]) ? "" : "/")) + resolvedAbsolute.parts.map(encodeSegment).join("/") + suffix };
      }

      return { action: "open", address: address };
    }

    /** Open a path in the bundled file manager (a new tab keeps the conversation intact). */
    function openInFileManager(path) {
      try {
        window.open("/-/files?path=" + encodeURIComponent(path), "_blank", "noopener");
        return true;
      } catch (error) {
        return false;
      }
    }

    /** Expose what the client half installed, so a live page can be inspected. */
    function setDiagnostic(key, value) {
      try {
        var diag = window.__dshLocalFiles || (window.__dshLocalFiles = {});
        diag[key] = value;
      } catch (error) { /* diagnostics only */ }
    }

    function cwdReader(scope) {
      return function (sessionId) {
        try {
          var list = scope.sessions && scope.sessions.list && scope.sessions.list.getSnapshot();
          var row = list && list.byId && list.byId[sessionId];
          return row && typeof row.cwd === "string" ? row.cwd : "";
        } catch (error) {
          return "";
        }
      };
    }

    /** Wrap `sidebarRight`'s two resource entry points so addresses are repaired before they are claimed. */
    function wrapResourceOpening(scope) {
      var sidebar = scope && scope.sidebarRight;
      if (!sidebar) { setDiagnostic("sidebarShape", "absent"); return function () {}; }
      var cwdOf = cwdReader(scope);
      var restores = [];

      function patch(name, build) {
        var original = sidebar[name];
        if (typeof original !== "function") return;
        var own = Object.prototype.hasOwnProperty.call(sidebar, name);
        sidebar[name] = function () {
          var args = Array.prototype.slice.call(arguments);
          var replaced = build(args, cwdOf);
          if (replaced === null) return undefined;
          return original.apply(this, replaced === undefined ? args : replaced);
        };
        restores.push(function () {
          if (own) sidebar[name] = original;
          else delete sidebar[name];
        });
      }

      patch("openResource", function (args, cwdOf) {
        if (typeof args[0] !== "string") return undefined;
        var plan = planFileOpen(args[0], cwdOf(sessionIdOf(args[0])));
        setDiagnostic("lastPlan", JSON.stringify({ in: args[0], action: plan.action, path: plan.path, address: plan.address }));
        if (plan.action === "browser") { openInFileManager(plan.path); return null; }
        return [plan.address, args[1]];
      });
      patch("openResourceIn", function (args, cwdOf) {
        if (typeof args[1] !== "string") return undefined;
        var plan = planFileOpen(args[1], cwdOf(args[0]));
        setDiagnostic("lastPlan", JSON.stringify({ in: args[1], action: plan.action, path: plan.path, address: plan.address }));
        if (plan.action === "browser") { openInFileManager(plan.path); return null; }
        return [args[0], plan.address, args[2]];
      });

      setDiagnostic("patchedCount", restores.length);
      return function restore() {
        for (var i = 0; i < restores.length; i += 1) restores[i]();
        setDiagnostic("restored", true);
      };
    }


    try {
      var diag = window.__dshLocalFiles || (window.__dshLocalFiles = {});
      diag.plan = planFileOpen;
    } catch (error) { /* diagnostics only */ }

    var inject = ["slots"];

    function apply(ctx) {
      try { var diag = window.__dshLocalFiles || (window.__dshLocalFiles = {}); diag.applyCount = (diag.applyCount || 0) + 1; } catch (error) { /* diagnostics only */ }
      ctx.slots.inject("sidebar.right.tab.document.actions", function () {
        return ctx.slots.register({
          name: "sidebar.right.tab.document.actions",
          id: "local-files",
          order: 20
        }, DocumentDownloadAction);
      });

      ctx.slots.inject("sidebar.right.tab.document.unpreviewable", function () {
        return ctx.slots.register({
          name: "sidebar.right.tab.document.unpreviewable",
          id: "local-files",
          order: 20
        }, UnpreviewableAction);
      });

      ctx.slots.inject("sidebar.right.tab.files.actions", function () {
        return ctx.slots.register({
          name: "sidebar.right.tab.files.actions",
          id: "local-files",
          order: 20
        }, FilesTabAction);
      });

      // Installs once both services exist; the disposer unwraps them again.
      // Guarded: a harness version without `inject` must still get the slots above.
      if (typeof ctx.inject === "function") {
        ctx.inject(["sidebarRight", "sessions"], function (scope) {
          // Cordis runs an effect body immediately and keeps its return value as
          // the disposer, so the patch must be installed *inside* the body.
          ctx.effect(function () {
            return wrapResourceOpening(scope);
          }, "local-files: repair file addresses");
        });
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = {
      normalizeFileAddress: normalizeFileAddress,
      planFileOpen: planFileOpen,
      nativePath: nativePath,
      sessionIdOf: sessionIdOf,
      resolveSegments: resolveSegments
    };
    return module.exports;
  }
});
