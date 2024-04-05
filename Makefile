.PHONY: dev setup

dev: vscode
	go run proxy.go

setup: vscode
	go mod tidy

vscode:
	git clone --depth=1 git@github.com:microsoft/vscode.git
