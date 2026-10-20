package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// settings 对应原版 PlayerPrefs 里持久化的内容（鉴权 token + 上次连接的地址）。
type settings struct {
	Token      string `json:"token"`
	Endpoint   string `json:"endpoint"`
	Language   string `json:"language"`
	PluginName string `json:"pluginName"`
	Developer  string `json:"developer"`
}
type store struct {
	path string
}

func defaultSettings() settings {
	return settings{
		Endpoint:   "", // 留空则首次启动走一次 UDP 端口发现，失败再兜底 127.0.0.1:8001
		Language:   "zh",
		PluginName: "ControlPad_Web",
		Developer:  "feifei2005",
	}
}

func newStore() *store {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return &store{path: filepath.Join(dir, "VTSControlPad.Web", "settings.json")}
}

func (s *store) load() (settings, error) {
	v := defaultSettings()
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return defaultSettings(), err
	}
	return v, nil
}

func (s *store) save(v settings) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, raw, 0o644)
}
