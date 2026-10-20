package main

import (
	"embed"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	webview "github.com/webview/webview_go"
)

//go:embed web
var webFiles embed.FS

const (
	appTitle    = "VTS Control Pad"
	appVersion  = "1.1.1-web"
	appHomepage = "https://github.com/feifei2005"
	appOriginal = "https://github.com/xiaoye97"
)

func main() {
	debug := flag.Bool("debug", false, "启用开发者工具（F12）并输出详细日志")
	timeout := flag.Duration("discover-timeout", 1500*time.Millisecond, "UDP 端口发现的最长等待时间")
	flag.Parse()

	logger, closeLog := newLogger()
	defer closeLog()

	page, err := buildPage()
	if err != nil {
		log.Fatalf("内置页面构建失败: %v", err)
	}

	h := &host{store: newStore(), log: logger, discoverTimeout: *timeout}

	w := webview.New(*debug)
	defer w.Destroy()
	w.SetTitle(appTitle)
	// HintNone 即普通可缩放窗口：横向拉宽后列表自动多排几列。
	w.SetSize(640, 800, webview.HintNone)

	bindings := map[string]any{
		"hostDiscover":     h.discover,
		"hostOpenURL":      h.openURL,
		"hostLoadSettings": h.loadSettings,
		"hostSaveSettings": h.saveSettings,
		"hostAppInfo":      h.appInfo,
		"hostLog":          h.logLine,
	}
	for name, fn := range bindings {
		if err := w.Bind(name, fn); err != nil {
			log.Fatalf("绑定 %s 失败: %v", name, err)
		}
	}

	w.SetHtml(page)
	w.Run()
}

// host 是暴露给页面的宿主能力集合。
type host struct {
	store           *store
	log             *log.Logger
	discoverTimeout time.Duration
}

// discover 监听 UDP 47779 并返回发现的 VTS 实例。
func (h *host) discover() ([]broadcast, error) {
	list, err := discoverPorts(h.discoverTimeout)
	if err != nil {
		h.log.Printf("UDP 端口发现失败: %v", err)
		return nil, err
	}
	h.log.Printf("UDP 端口发现完成，命中 %d 个实例", len(list))
	if list == nil {
		list = []broadcast{}
	}
	return list, nil
}

// openURL 用系统默认浏览器打开外部链接，避免 WebView 自身导航离开应用。
func (h *host) openURL(u string) (bool, error) {
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
		return false, errors.New("仅允许 http/https 链接")
	}
	h.log.Printf("打开外部链接: %s", u)
	err := exec.Command("rundll32", "url.dll,FileProtocolHandler", u).Start()
	return err == nil, err
}

func (h *host) loadSettings() (settings, error) {
	return h.store.load()
}

func (h *host) saveSettings(v settings) (bool, error) {
	if err := h.store.save(v); err != nil {
		return false, err
	}
	return true, nil
}

func (h *host) appInfo() map[string]string {
	return map[string]string{
		"version":  appVersion,
		"homepage": appHomepage,
		"original": appOriginal,
	}
}

func (h *host) logLine(msg string) bool {
	h.log.Printf("[web] %s", msg)
	return true
}

// newLogger 把日志同时写到 %APPDATA%\VTSControlPad.Web\app.log 和 stderr。
func newLogger() (*log.Logger, func()) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return log.New(io.Discard, "", 0), func() {}
	}
	dir = filepath.Join(dir, "VTSControlPad.Web")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return log.New(io.Discard, "", 0), func() {}
	}
	f, err := os.OpenFile(filepath.Join(dir, "app.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return log.New(io.Discard, "", 0), func() {}
	}
	return log.New(io.MultiWriter(f, os.Stderr), "", log.LstdFlags), func() { f.Close() }
}

// buildPage 把 index.html 中的 CSS / JS 占位符替换为内嵌资源，得到单文件页面。
// 页面走 SetHtml（NavigateToString），因此脚本必须内联，不能有外部引用。
func buildPage() (string, error) {
	html, err := webFiles.ReadFile("web/index.html")
	if err != nil {
		return "", err
	}

	var sb strings.Builder
	for _, name := range []string{"web/i18n.js", "web/vts.js", "web/app.js"} {
		raw, err := webFiles.ReadFile(name)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&sb, "<script>\n%s\n</script>\n", raw)
	}

	css, err := webFiles.ReadFile("web/app.css")
	if err != nil {
		return "", err
	}

	out := string(html)
	out = strings.Replace(out, "<!--__CSS__-->", "<style>\n"+string(css)+"\n</style>", 1)
	out = strings.Replace(out, "<!--__JS__-->", sb.String(), 1)
	return out, nil
}
