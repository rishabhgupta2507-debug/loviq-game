const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = {};

function generateCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// Send same question to both players simultaneously
function sendQuestion(room, code) {
  room.answers = { 0: null, 1: null }; // reset answers for both players
  room.questionAnswered = false;
  room.timerStart = Date.now();

  io.to(code).emit('new_question', {
    level: room.level,
    qIndex: room.qIndex,
    players: room.players.map(p => ({ name: p.name, score: p.score }))
  });
}

function handleNextQuestion(room, code) {
  const totalQ = 10;
  room.qIndex += 1;

  if (room.qIndex >= totalQ) {
    if (room.level >= 2) {
      room.started = false;
      io.to(code).emit('game_over', {
        players: room.players.map(p => ({ name: p.name, score: p.score }))
      });
    } else {
      room.level += 1;
      room.qIndex = 0;
      io.to(code).emit('level_up', {
        level: room.level,
        players: room.players.map(p => ({ name: p.name, score: p.score }))
      });
    }
  } else {
    sendQuestion(room, code);
  }
}

function processAnswers(room, code) {
  // Called when both players have answered OR both timed out
  const results = [];
  room.players.forEach((p, idx) => {
    const ans = room.answers[idx];
    const correct = ans && ans.correct;
    const pts = correct ? (room.level === 0 ? 10 : room.level === 1 ? 25 : 50) : 0;
    p.score += pts;
    results.push({ name: p.name, correct: !!correct, pts, score: p.score });
  });

  io.to(code).emit('question_result', {
    results,
    players: room.players.map(p => ({ name: p.name, score: p.score }))
  });

  setTimeout(() => handleNextQuestion(room, code), 2500);
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Create room
  socket.on('create_room', ({ playerName }) => {
    const code = generateCode();
    rooms[code] = {
      code,
      players: [{ id: socket.id, name: playerName, score: 0 }],
      level: 0, qIndex: 0,
      started: false,
      questionAnswered: false,
      answers: { 0: null, 1: null },
      timerStart: null
    };
    socket.join(code);
    socket.emit('room_created', { code });
    socket.emit('room_update', {
      players: rooms[code].players.map(p => ({ name: p.name, score: p.score }))
    });
    console.log('Room created:', code, 'by', playerName);
  });

  // Join room — FIX: send roomCode back to Player 2
  socket.on('join_room', ({ code, playerName }) => {
    const upperCode = code.trim().toUpperCase();
    const room = rooms[upperCode];
    if (!room) { socket.emit('join_error', { msg: 'Room not found! Check your code.' }); return; }
    if (room.players.length >= 2) { socket.emit('join_error', { msg: 'Room is full!' }); return; }
    if (room.started) { socket.emit('join_error', { msg: 'Game already started!' }); return; }

    room.players.push({ id: socket.id, name: playerName, score: 0 });
    socket.join(upperCode);

    // FIX: Send roomCode back to Player 2
    socket.emit('joined_room', { code: upperCode });

    io.to(upperCode).emit('room_update', {
      players: room.players.map(p => ({ name: p.name, score: p.score }))
    });
    console.log(playerName, 'joined room:', upperCode);
  });

  // Start game
  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    if (room.players[0].id !== socket.id) { socket.emit('join_error', { msg: 'Only the host can start!' }); return; }
    if (room.players.length < 2) { socket.emit('join_error', { msg: 'Partner has not joined yet!' }); return; }

    room.started = true;
    room.level = 0;
    room.qIndex = 0;
    room.players.forEach(p => p.score = 0);

    io.to(code).emit('game_started', {
      level: 0,
      players: room.players.map(p => ({ name: p.name, score: p.score }))
    });

    // Send first question after short delay
    setTimeout(() => sendQuestion(room, code), 1000);
  });

  // Submit answer — both players answer SAME question simultaneously
  socket.on('submit_answer', ({ code, correct, answerText }) => {
    const room = rooms[code];
    if (!room || !room.started) return;

    // Find which player this is
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx === -1) return;

    // Don't allow double submission from same player
    if (room.answers[playerIdx] !== null) return;

    room.answers[playerIdx] = { correct, answerText };
    console.log(`Player ${playerIdx} answered Q${room.qIndex}: ${correct ? 'correct' : 'wrong'}`);

    // Notify the other player someone answered
    socket.to(code).emit('partner_answered', { playerName: room.players[playerIdx].name });

    // If both players have answered, process results
    if (room.answers[0] !== null && room.answers[1] !== null) {
      processAnswers(room, code);
    }
  });

  // Timeout — player ran out of time
  socket.on('timeout', ({ code }) => {
    const room = rooms[code];
    if (!room || !room.started) return;

    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx === -1) return;
    if (room.answers[playerIdx] !== null) return; // already answered

    room.answers[playerIdx] = { correct: false, answerText: null, timedOut: true };
    console.log(`Player ${playerIdx} timed out on Q${room.qIndex}`);

    socket.to(code).emit('partner_timeout', { playerName: room.players[playerIdx].name });

    // If both have answered/timed out, process
    if (room.answers[0] !== null && room.answers[1] !== null) {
      processAnswers(room, code);
    }
  });

  // Chat
  socket.on('chat_message', ({ code, message, sender }) => {
    if (!rooms[code]) return;
    io.to(code).emit('chat_message', {
      message, sender,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        io.to(code).emit('player_left', { name: room.players[idx].name });
        delete rooms[code];
        console.log('Room', code, 'deleted');
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Loviq running on port ${PORT}`));
