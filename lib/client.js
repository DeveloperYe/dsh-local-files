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
      return /^[A-Za-z]:[\\/]/.test(path) || path.charAt(0) === "/";
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
      if (!sidebar) return function () {};
      var cwdOf = cwdReader(scope);
      var restores = [];

      function patch(name, build) {
        var original = sidebar[name];
        if (typeof original !== "function") return;
        var own = Object.prototype.hasOwnProperty.call(sidebar, name);
        sidebar[name] = function () {
          var args = Array.prototype.slice.call(arguments);
          var replaced = build(args, cwdOf);
          return original.apply(this, replaced === undefined ? args : replaced);
        };
        restores.push(function () {
          if (own) sidebar[name] = original;
          else delete sidebar[name];
        });
      }

      patch("openResource", function (args, cwdOf) {
        if (typeof args[0] !== "string") return undefined;
        return [normalizeFileAddress(args[0], cwdOf(sessionIdOf(args[0]))), args[1]];
      });
      patch("openResourceIn", function (args, cwdOf) {
        if (typeof args[1] !== "string") return undefined;
        return [args[0], normalizeFileAddress(args[1], cwdOf(args[0])), args[2]];
      });

      return function restore() {
        for (var i = 0; i < restores.length; i += 1) restores[i]();
      };
    }

    var inject = ["slots"];

    function apply(ctx) {
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
          var restore = wrapResourceOpening(scope);
          var owner = scope && typeof scope.effect === "function" ? scope : ctx;
          if (owner && typeof owner.effect === "function") owner.effect(restore, "local-files: repair .. in file addresses");
          else restore();
        });
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = {
      normalizeFileAddress: normalizeFileAddress,
      sessionIdOf: sessionIdOf,
      resolveSegments: resolveSegments
    };
    return module.exports;
  }
});
