// ===== CONFIGURATION =====
const API_URL = 'http://localhost:3000/api';
const socket = io('http://localhost:3000');

// ===== STATE =====
let currentUser = null;
let selectedUser = null;
let token = null;
let users = [];
let typingTimeout = null;

// WebRTC
let localStream = null;
let remoteStream = null;
let peerConnection = null;
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// ===== AUTHENTICATION =====
function showLogin() {
    document.getElementById('login-form').style.display = 'block';
    document.getElementById('register-form').style.display = 'none';
}

function showRegister() {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'block';
}

async function register() {
    const username = document.getElementById('register-username').value;
    const email = document.getElementById('register-email').value;
    const password = document.getElementById('register-password').value;

    if (!username || !email || !password) {
        alert('Vui lòng điền đầy đủ thông tin!');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, email, password })
        });

        const data = await response.json();

        if (response.ok) {
            token = data.token;
            currentUser = data.user;
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(currentUser));
            showChatScreen();
        } else {
            alert(data.error || 'Đăng ký thất bại!');
        }
    } catch (error) {
        alert('Lỗi kết nối server!');
        console.error(error);
    }
}

async function login() {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    if (!email || !password) {
        alert('Vui lòng điền đầy đủ thông tin!');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (response.ok) {
            token = data.token;
            currentUser = data.user;
            localStorage.setItem('token', token);
            localStorage.setItem('user', JSON.stringify(currentUser));
            showChatScreen();
        } else {
            alert(data.error || 'Đăng nhập thất bại!');
        }
    } catch (error) {
        alert('Lỗi kết nối server!');
        console.error(error);
    }
}

function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    token = null;
    currentUser = null;
    selectedUser = null;
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('chat-screen').style.display = 'none';
    socket.disconnect();
}

function showChatScreen() {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('chat-screen').style.display = 'flex';
    
    // Set current user info
    document.getElementById('current-username').textContent = currentUser.username;
    document.getElementById('current-user-avatar').src = currentUser.avatar;
    
    // Connect to socket
    socket.connect();
    socket.emit('user-online', currentUser.id);
    
    // Load contacts
    loadContacts();
}

// ===== CONTACTS =====
async function loadContacts() {
    try {
        const response = await fetch(`${API_URL}/users`);
        users = await response.json();
        
        const contactsList = document.getElementById('contacts-list');
        contactsList.innerHTML = '';
        
        users.forEach(user => {
            if (user.id !== currentUser.id) {
                const contactItem = document.createElement('div');
                contactItem.className = 'contact-item';
                contactItem.onclick = () => selectUser(user);
                
                contactItem.innerHTML = `
                    <div class="contact-avatar">
                        <img src="${user.avatar}" alt="${user.username}">
                        ${user.online ? '<div class="online-indicator"></div>' : ''}
                    </div>
                    <div class="contact-info">
                        <h4>${user.username}</h4>
                        <p>${user.online ? 'Đang hoạt động' : 'Không hoạt động'}</p>
                    </div>
                `;
                
                contactsList.appendChild(contactItem);
            }
        });
    } catch (error) {
        console.error('Error loading contacts:', error);
    }
}

async function selectUser(user) {
    selectedUser = user;
    
    // Update UI
    document.querySelectorAll('.contact-item').forEach(item => {
        item.classList.remove('active');
    });
    event.currentTarget.classList.add('active');
    
    document.getElementById('no-chat-selected').style.display = 'none';
    document.getElementById('chat-container').style.display = 'flex';
    
    document.getElementById('chat-user-name').textContent = user.username;
    document.getElementById('chat-user-avatar').src = user.avatar;
    
    const statusElement = document.getElementById('chat-user-status');
    statusElement.textContent = user.online ? 'Đang hoạt động' : 'Không hoạt động';
    statusElement.className = user.online ? 'status-text online' : 'status-text';
    
    // Load messages
    await loadMessages();
    
    // Focus input
    document.getElementById('message-input').focus();
}

async function loadMessages() {
    try {
        const response = await fetch(`${API_URL}/messages/${currentUser.id}/${selectedUser.id}`);
        const messages = await response.json();
        
        const messagesContainer = document.getElementById('messages-container');
        messagesContainer.innerHTML = '';
        
        messages.forEach(msg => {
            displayMessage(msg);
        });
        
        scrollToBottom();
    } catch (error) {
        console.error('Error loading messages:', error);
    }
}

// ===== MESSAGING =====
function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    
    if (!text || !selectedUser) return;
    
    socket.emit('send-message', {
        from: currentUser.id,
        to: selectedUser.id,
        text: text
    });
    
    input.value = '';
    socket.emit('stop-typing', { to: selectedUser.id });
}

function displayMessage(message) {
    const messagesContainer = document.getElementById('messages-container');
    const messageDiv = document.createElement('div');
    
    const isSent = message.from === currentUser.id;
    messageDiv.className = `message ${isSent ? 'sent' : 'received'}`;
    
    const time = new Date(message.timestamp).toLocaleTimeString('vi-VN', { 
        hour: '2-digit', 
        minute: '2-digit' 
    });
    
    messageDiv.innerHTML = `
        <div class="message-bubble">
            ${message.text}
            <div class="message-time">${time}</div>
        </div>
    `;
    
    messagesContainer.appendChild(messageDiv);
    scrollToBottom();
}

function scrollToBottom() {
    const container = document.getElementById('messages-container');
    container.scrollTop = container.scrollHeight;
}

// Handle typing indicator
document.getElementById('message-input')?.addEventListener('input', (e) => {
    if (!selectedUser) return;
    
    if (e.target.value.trim()) {
        socket.emit('typing', { to: selectedUser.id });
        
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            socket.emit('stop-typing', { to: selectedUser.id });
        }, 1000);
    } else {
        socket.emit('stop-typing', { to: selectedUser.id });
    }
});

// Send on Enter
document.getElementById('message-input')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessage();
    }
});

// ===== VIDEO CALL =====
async function startVideoCall() {
    if (!selectedUser) return;
    
    try {
        // Get local stream
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        
        document.getElementById('local-video').srcObject = localStream;
        document.getElementById('video-call-modal').style.display = 'flex';
        document.getElementById('call-user-name').textContent = selectedUser.username;
        
        // Create peer connection
        peerConnection = new RTCPeerConnection(configuration);
        
        // Add local tracks
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        // Handle remote stream
        peerConnection.ontrack = (event) => {
            if (!remoteStream) {
                remoteStream = new MediaStream();
                document.getElementById('remote-video').srcObject = remoteStream;
            }
            remoteStream.addTrack(event.track);
        };
        
        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice-candidate', {
                    to: selectedUser.id,
                    candidate: event.candidate
                });
            }
        };
        
        // Create and send offer
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        socket.emit('call-user', {
            to: selectedUser.id,
            from: currentUser.id,
            offer: offer
        });
        
    } catch (error) {
        console.error('Error starting call:', error);
        alert('Không thể truy cập camera/micro!');
    }
}

function endCall() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    if (remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
        remoteStream = null;
    }
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    document.getElementById('video-call-modal').style.display = 'none';
}

// ===== SOCKET EVENTS =====
socket.on('receive-message', (message) => {
    if (selectedUser && (message.from === selectedUser.id || message.to === selectedUser.id)) {
        displayMessage(message);
    }
});

socket.on('message-sent', (message) => {
    displayMessage(message);
});

socket.on('user-typing', (userId) => {
    if (selectedUser && userId === selectedUser.id) {
        document.getElementById('typing-indicator').style.display = 'flex';
        scrollToBottom();
    }
});

socket.on('user-stop-typing', (userId) => {
    if (selectedUser && userId === selectedUser.id) {
        document.getElementById('typing-indicator').style.display = 'none';
    }
});

socket.on('user-status-change', ({ userId, online }) => {
    // Update contacts list
    const user = users.find(u => u.id === userId);
    if (user) {
        user.online = online;
        loadContacts();
        
        // Update chat header if this is the selected user
        if (selectedUser && selectedUser.id === userId) {
            const statusElement = document.getElementById('chat-user-status');
            statusElement.textContent = online ? 'Đang hoạt động' : 'Không hoạt động';
            statusElement.className = online ? 'status-text online' : 'status-text';
        }
    }
});

socket.on('incoming-call', async ({ from, offer }) => {
    const caller = users.find(u => u.id === from);
    if (!caller) return;
    
    const accept = confirm(`${caller.username} đang gọi cho bạn. Chấp nhận?`);
    
    if (accept) {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            
            document.getElementById('local-video').srcObject = localStream;
            document.getElementById('video-call-modal').style.display = 'flex';
            document.getElementById('call-user-name').textContent = caller.username;
            document.getElementById('call-status').textContent = 'Đang kết nối...';
            
            peerConnection = new RTCPeerConnection(configuration);
            
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
            });
            
            peerConnection.ontrack = (event) => {
                if (!remoteStream) {
                    remoteStream = new MediaStream();
                    document.getElementById('remote-video').srcObject = remoteStream;
                }
                remoteStream.addTrack(event.track);
                document.getElementById('call-status').textContent = 'Đã kết nối';
            };
            
            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    socket.emit('ice-candidate', {
                        to: from,
                        candidate: event.candidate
                    });
                }
            };
            
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            socket.emit('accept-call', {
                to: from,
                from: currentUser.id,
                answer: answer
            });
            
        } catch (error) {
            console.error('Error accepting call:', error);
        }
    }
});

socket.on('call-accepted', async ({ from, answer }) => {
    document.getElementById('call-status').textContent = 'Đã kết nối';
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('ice-candidate', async ({ from, candidate }) => {
    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
        console.error('Error adding ICE candidate:', error);
    }
});

// ===== AUTO LOGIN =====
window.addEventListener('load', () => {
    const savedToken = localStorage.getItem('token');
    const savedUser = localStorage.getItem('user');
    
    if (savedToken && savedUser) {
        token = savedToken;
        currentUser = JSON.parse(savedUser);
        showChatScreen();
    }
});
