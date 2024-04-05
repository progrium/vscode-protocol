package main

import (
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/dop251/goja"
	esbuild "github.com/evanw/esbuild/pkg/api"
	"github.com/gorilla/websocket"
)

var src string
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

func main() {
	result := esbuild.Build(esbuild.BuildOptions{
		EntryPoints: []string{"decoder.ts"},
		Write:       false,
		Target:      esbuild.ES2015,
		Bundle:      true,
	})
	if len(result.Errors) > 0 {
		log.Fatal(result.Errors)
	}
	src = string(result.OutputFiles[0].Contents)

	u, err := url.Parse("http://localhost:3000")
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("proxying to :3000 on :8000 ...")
	http.ListenAndServe(":8000", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {

		if websocket.IsWebSocketUpgrade(r) {
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				log.Println(err)
				return
			}
			defer conn.Close()

			token := r.URL.Query().Get("reconnectionToken")

			u := r.URL
			u.Host = "localhost:3000"
			u.Scheme = "ws"
			log.Println("ws proxy to ", u.String())
			targetConn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
			if err != nil {
				log.Println("Dial error:", err)
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			defer targetConn.Close()

			// frontend to backend
			go func() {
				vm := newParserVM(token, ">>")

				for {
					t, buf, err := conn.ReadMessage()
					if err != nil {
						log.Println("read error:", err)
						return
					}
					if t != websocket.BinaryMessage {
						continue
					}

					vm.Push(buf)

					if err := targetConn.WriteMessage(websocket.BinaryMessage, buf); err != nil {
						log.Println("Write to target error:", err)
						return
					}
				}
			}()

			// backend to frontend
			vm := newParserVM(token, "<<")
			for {
				t, buf, err := targetConn.ReadMessage()
				if err != nil {
					log.Println("Read from target error:", err)
					return
				}
				if t != websocket.BinaryMessage {
					continue
				}

				vm.Push(buf)

				if err := conn.WriteMessage(websocket.BinaryMessage, buf); err != nil {
					log.Println("Write to client error:", err)
					return
				}
			}

		}
		httputil.NewSingleHostReverseProxy(u).ServeHTTP(w, r)
	}))

}

type parserVM struct {
	*goja.Runtime
	push  goja.Callable
	token string
	dir   string
}

func (vm *parserVM) Push(data []byte) {
	_, err := vm.push(goja.Undefined(), vm.ToValue(data))
	if err != nil {
		panic(err)
	}
}

func newParserVM(token, dir string) *parserVM {
	vm := goja.New()

	console := vm.NewObject()
	console.Set("log", func(call goja.FunctionCall) goja.Value {
		for _, argument := range call.Arguments {
			fmt.Println(argument.String())
		}
		return nil
	})
	console.Set("error", func(call goja.FunctionCall) goja.Value {
		for _, argument := range call.Arguments {
			fmt.Println("ERROR:", argument.String())
		}
		return nil
	})
	vm.Set("console", console)

	vm.Set("queueMicrotask", func(call goja.FunctionCall) goja.Value {
		fn, ok := goja.AssertFunction(call.Arguments[0])
		if !ok {
			panic("not a function")
		}
		fn(goja.Undefined())
		return nil
	})

	vm.Set("setTimeout", func(call goja.FunctionCall) goja.Value {
		fn, ok := goja.AssertFunction(call.Arguments[0])
		if !ok {
			panic("not a function")
		}
		fn(goja.Undefined())
		return nil
	})

	nav := vm.NewObject()
	nav.Set("userAgent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36")
	nav.Set("language", "en-US")
	vm.Set("navigator", nav)

	_, err := vm.RunString(src)
	if err != nil {
		panic(err)
	}

	tokenParts := strings.Split(token, "-")
	tokenSuffix := tokenParts[len(tokenParts)-1]

	vm.GlobalObject().Set("tokenSuffix", tokenSuffix)
	vm.GlobalObject().Set("dir", dir)

	pvm := &parserVM{
		Runtime: vm,
		token:   token,
		dir:     dir,
	}
	var ok bool
	pvm.push, ok = goja.AssertFunction(vm.Get("push"))
	if !ok {
		panic("Not a function")
	}
	return pvm
}
