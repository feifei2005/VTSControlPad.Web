package main

import (
	"context"
	"encoding/json"
	"net"
	"sort"
	"strconv"
	"syscall"
	"time"
)

// VTube Studio 会把 "VTubeStudioAPIStateBroadcast" 报文广播到 UDP 47779 端口，
// 报文里带着它当前监听的 API 端口号。浏览器沙箱拿不到 UDP，所以这一步由宿主来做。
const (
	udpDiscoveryPort = 47779
	broadcastType    = "VTubeStudioAPIStateBroadcast"
)

// broadcast 是返回给页面的发现结果。
type broadcast struct {
	IP          string `json:"ip"`
	Port        int    `json:"port"`
	InstanceID  string `json:"instanceID"`
	WindowTitle string `json:"windowTitle"`
}

type stateBroadcast struct {
	MessageType string `json:"messageType"`
	Data        struct {
		Active      bool   `json:"active"`
		Port        int    `json:"port"`
		InstanceID  string `json:"instanceID"`
		WindowTitle string `json:"windowTitle"`
	} `json:"data"`
}

// reuseAddr 让宿主与 VTS 本体可以同时绑定 47779（原版同样使用 SO_REUSEADDR）。
func reuseAddr(network, address string, c syscall.RawConn) error {
	var opErr error
	if err := c.Control(func(fd uintptr) {
		opErr = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1)
	}); err != nil {
		return err
	}
	return opErr
}

// discoverPorts 在 timeout 内收集所有 active 的广播端口，本机回环地址排在最前。
func discoverPorts(timeout time.Duration) ([]broadcast, error) {
	lc := net.ListenConfig{Control: reuseAddr}
	conn, err := lc.ListenPacket(context.Background(), "udp4", "0.0.0.0:"+strconv.Itoa(udpDiscoveryPort))
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(timeout))

	seen := map[string]broadcast{}
	buf := make([]byte, 4096)
	for {
		n, addr, err := conn.ReadFrom(buf)
		if err != nil {
			break // 超时即结束收集
		}
		var msg stateBroadcast
		if json.Unmarshal(buf[:n], &msg) != nil || msg.MessageType != broadcastType || !msg.Data.Active {
			continue
		}
		udpAddr, ok := addr.(*net.UDPAddr)
		if !ok {
			continue
		}
		ip := udpAddr.IP.String()
		seen[ip+":"+strconv.Itoa(msg.Data.Port)] = broadcast{
			IP:          ip,
			Port:        msg.Data.Port,
			InstanceID:  msg.Data.InstanceID,
			WindowTitle: msg.Data.WindowTitle,
		}
	}

	list := make([]broadcast, 0, len(seen))
	for _, b := range seen {
		list = append(list, b)
	}
	sort.Slice(list, func(i, j int) bool {
		if (list[i].IP == "127.0.0.1") != (list[j].IP == "127.0.0.1") {
			return list[i].IP == "127.0.0.1"
		}
		return list[i].IP < list[j].IP
	})
	return list, nil
}
