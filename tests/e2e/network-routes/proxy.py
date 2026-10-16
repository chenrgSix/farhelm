import socket, threading

def copy(source, target):
    try:
        while data := source.recv(65536):
            target.sendall(data)
    except OSError:
        pass
    finally:
        source.close()
        target.close()

server = socket.create_server(('0.0.0.0', 8444))
while True:
    source, _ = server.accept()
    target = socket.create_connection(('127.0.0.1', 8443))
    threading.Thread(target=copy, args=(source, target), daemon=True).start()
    threading.Thread(target=copy, args=(target, source), daemon=True).start()
