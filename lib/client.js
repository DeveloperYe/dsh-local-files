/**
 * dsh-local-files — client half.
 *
 * Adds the missing "download to my machine" exit to the right Sidebar document
 * preview and a shortcut from the workspace file tree to the full local file
 * browser page (/-/files). Plain JS: client modules are loaded through
 * window.__ModuleLoader__ (CommonJS closure factory), which tsc cannot emit.
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
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
