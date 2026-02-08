// ===== CONFIGURATION =====
const API_URL = 'http://localhost:3000/api';
const socket = io('http://localhost:3000');

// ===== STATE =====
let currentUser = null;
let selectedUser = null;
let token = null;
let users = [];
let friends = [];
let friendRequests = [];
let typingTimeout = null;
let searchTimeout = null;

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
    loadFriends();
    loadFriendRequests();
}

// ===== TABS =====
function showTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach((btn, index) => {
        btn.classList.remove('active');
        const tabNames = ['chat', 'friends', 'search'];
        if (tabNames[index] === tabName) {
            btn.classList.add('active');
        }
    });
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
        content.style.display = 'none';
    });
    
    const targetTab = document.getElementById(`${tabName}-tab`);
    if (targetTab) {
        targetTab.classList.add('active');
        targetTab.style.display = 'flex';
    }
    
    // Load data based on tab
    if (tabName === 'friends') {
        loadFriends();
        loadFriendRequests();
    }
}

// ===== CONTACTS =====
async function loadContacts() {
    try {
        const response = await fetch(`${API_URL}/users`);
        users = await response.json();
        
        const contactsList = document.getElementById('contacts-list');
        contactsList.innerHTML = '';
        
        // Only show friends in contacts list
        const friendResponse = await fetch(`${API_URL}/friends/${currentUser.id}`);
        friends = await friendResponse.json();
        
        if (friends.length === 0) {
            contactsList.innerHTML = `
                <div class="empty-state">
                    <svg width="80" height="80" viewBox="0 0 24 24" fill="#e4e6eb">
                        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
                    </svg>
                    <p>Chưa có bạn bè nào<br>Hãy thêm bạn bè để bắt đầu chat!</p>
                </div>
            `;
            return;
        }
        
        friends.forEach(user => {
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
        });
    } catch (error) {
        console.error('Error loading contacts:', error);
    }
}

// ===== FRIENDS =====
async function loadFriends() {
    try {
        const response = await fetch(`${API_URL}/friends/${currentUser.id}`);
        friends = await response.json();
        
        document.getElementById('friends-count').textContent = friends.length;
        
        const friendsList = document.getElementById('friends-list');
        friendsList.innerHTML = '';
        
        if (friends.length === 0) {
            friendsList.innerHTML = `
                <div class="empty-state">
                    <svg width="80" height="80" viewBox="0 0 24 24" fill="#e4e6eb">
                        <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                    </svg>
                    <p>Chưa có bạn bè nào</p>
                </div>
            `;
            return;
        }
        
        friends.forEach(friend => {
            const friendItem = document.createElement('div');
            friendItem.className = 'contact-item';
            friendItem.onclick = () => {
                showTab('chat');
                selectUser(friend);
            };
            
            friendItem.innerHTML = `
                <div class="contact-avatar">
                    <img src="${friend.avatar}" alt="${friend.username}">
                    ${friend.online ? '<div class="online-indicator"></div>' : ''}
                </div>
                <div class="contact-info">
                    <h4>${friend.username}</h4>
                    <p>${friend.online ? 'Đang hoạt động' : 'Không hoạt động'}</p>
                </div>
            `;
            
            friendsList.appendChild(friendItem);
        });
    } catch (error) {
        console.error('Error loading friends:', error);
    }
}

async function loadFriendRequests() {
    try {
        const response = await fetch(`${API_URL}/friend-requests/${currentUser.id}`);
        friendRequests = await response.json();
        
        const badge = document.getElementById('friend-request-badge');
        const requestsSection = document.getElementById('friend-requests-section');
        const requestsList = document.getElementById('friend-requests-list');
        
        if (friendRequests.length === 0) {
            badge.style.display = 'none';
            requestsSection.style.display = 'none';
            return;
        }
        
        badge.textContent = friendRequests.length;
        badge.style.display = 'inline-block';
        requestsSection.style.display = 'block';
        requestsList.innerHTML = '';
        
        friendRequests.forEach(request => {
            const requestItem = document.createElement('div');
            requestItem.className = 'friend-request-item';
            
            requestItem.innerHTML = `
                <img src="${request.sender.avatar}" alt="${request.sender.username}">
                <div class="friend-request-info">
                    <h4>${request.sender.username}</h4>
                    <div class="friend-request-actions">
                        <button class="btn-accept" onclick="respondToFriendRequest('${request.id}', 'accept')">
                            Chấp nhận
                        </button>
                        <button class="btn-reject" onclick="respondToFriendRequest('${request.id}', 'reject')">
                            Từ chối
                        </button>
                    </div>
                </div>
            `;
            
            requestsList.appendChild(requestItem);
        });
    } catch (error) {
        console.error('Error loading friend requests:', error);
    }
}

async function respondToFriendRequest(requestId, action) {
    try {
        const response = await fetch(`${API_URL}/friend-request/${requestId}/respond`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ action })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            loadFriendRequests();
            loadFriends();
            loadContacts();
        } else {
            alert(data.error || 'Có lỗi xảy ra');
        }
    } catch (error) {
        console.error('Error responding to friend request:', error);
    }
}

// ===== SEARCH USERS =====
async function searchUsers() {
    const query = document.getElementById('user-search-input').value.trim();
    const resultsContainer = document.getElementById('search-results');
    
    if (query.length < 2) {
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <svg width="80" height="80" viewBox="0 0 24 24" fill="#e4e6eb">
                    <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                </svg>
                <p>Nhập tên hoặc email để tìm kiếm</p>
            </div>
        `;
        return;
    }
    
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
        try {
            const response = await fetch(`${API_URL}/search/users?q=${encodeURIComponent(query)}&userId=${currentUser.id}`);
            const results = await response.json();
            
            resultsContainer.innerHTML = '';
            
            if (results.length === 0) {
                resultsContainer.innerHTML = `
                    <div class="empty-state">
                        <svg width="80" height="80" viewBox="0 0 24 24" fill="#e4e6eb">
                            <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
                        </svg>
                        <p>Không tìm thấy kết quả</p>
                    </div>
                `;
                return;
            }
            
            results.forEach(user => {
                const resultItem = document.createElement('div');
                resultItem.className = 'search-result-item';
                
                let actionButton = '';
                if (user.isFriend) {
                    actionButton = `<button class="btn-message" onclick="messageUser('${user.id}')">Nhắn tin</button>`;
                } else if (user.hasPendingRequest) {
                    if (user.requestSentByMe) {
                        actionButton = `<button class="btn-pending">Đã gửi lời mời</button>`;
                    } else {
                        actionButton = `<button class="btn-pending">Đang chờ phản hồi</button>`;
                    }
                } else {
                    actionButton = `<button class="btn-add-friend" onclick="sendFriendRequest('${user.id}')">Kết bạn</button>`;
                }
                
                resultItem.innerHTML = `
                    <img src="${user.avatar}" alt="${user.username}">
                    <div class="search-result-info">
                        <h4>${user.username}</h4>
                        <p>${user.email}</p>
                    </div>
                    ${actionButton}
                `;
                
                resultsContainer.appendChild(resultItem);
            });
        } catch (error) {
            console.error('Error searching users:', error);
        }
    }, 500);
}

async function sendFriendRequest(toUserId) {
    try {
        const response = await fetch(`${API_URL}/friend-request`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: currentUser.id,
                to: toUserId
            })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            // Refresh search results
            searchUsers();
        } else {
            alert(data.error || 'Có lỗi xảy ra');
        }
    } catch (error) {
        console.error('Error sending friend request:', error);
    }
}

function messageUser(userId) {
    const user = users.find(u => u.id === userId) || friends.find(f => f.id === userId);
    if (user) {
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.querySelector('.tab-btn').classList.add('active');
        showTab('chat');
        selectUser(user);
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

socket.on('friend-request-received', (request) => {
    loadFriendRequests();
    
    // Show notification
    if (Notification.permission === 'granted') {
        new Notification('Lời mời kết bạn mới', {
            body: `${request.sender?.username || 'Ai đó'} đã gửi lời mời kết bạn`,
            icon: request.sender?.avatar
        });
    }
});

socket.on('friend-request-accepted', (request) => {
    loadFriends();
    loadContacts();
    
    // Show notification
    if (Notification.permission === 'granted') {
        const accepter = users.find(u => u.id === request.to);
        new Notification('Lời mời kết bạn được chấp nhận', {
            body: `${accepter?.username || 'Ai đó'} đã chấp nhận lời mời kết bạn của bạn`,
            icon: accepter?.avatar
        });
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
    
    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
});
