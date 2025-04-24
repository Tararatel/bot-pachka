require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const API_TOKEN = process.env.PACHCA_API_TOKEN;
const SECRET_TOKEN = process.env.PACHCA_SECRET_TOKEN;
const EXCLUDED_USER_IDS = process.env.EXCLUDED_USER_IDS
  ? process.env.EXCLUDED_USER_IDS.split(',').map((id) => parseInt(id.trim()))
  : [];
const TAG_TYPE = process.env.TAG_TYPE || 'list_tags';

// Функция для проверки подписи
function verifySignature(req) {
  const signature = req.headers['pachca-signature'] || req.headers['Pachca-Signature'];
  if (!signature) {
    console.error('Отсутствует заголовок подписи');
    return false;
  }
  const hmac = crypto.createHmac('sha256', SECRET_TOKEN);
  const payload = JSON.stringify(req.body);
  const calculatedSignature = hmac.update(payload).digest('hex');
  console.log('Полученная подпись:', signature);
  console.log('Вычисленная подпись:', calculatedSignature);
  return signature === calculatedSignature;
}

// Функция для перемешивания массива
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Функция для создания групп
function createGroups(participants, groupSize) {
  const shuffled = shuffle([...participants]);
  const groups = [];
  for (let i = 0; i < shuffled.length; i += groupSize) {
    groups.push(shuffled.slice(i, i + groupSize));
  }
  return groups;
}

// Получение участников чата
async function getChatParticipants(chatId, tag = null) {
  try {
    console.log(`Запрос чата: https://api.pachca.com/api/shared/v1/chats/${chatId}`);
    const chatResponse = await axios.get(
      `https://api.pachca.com/api/shared/v1/chats/${chatId}`,
      {
        headers: { Authorization: `Bearer ${API_TOKEN}` },
      },
    );
    console.log('Ответ чата:', JSON.stringify(chatResponse.data, null, 2));
    const memberIds = chatResponse.data.data.member_ids;

    console.log(`Запрос пользователей: https://api.pachca.com/api/shared/v1/users`);
    const usersResponse = await axios.get(`https://api.pachca.com/api/shared/v1/users`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    console.log('Ответ пользователей:', JSON.stringify(usersResponse.data, null, 2));

    let participants = usersResponse.data.data.filter(
      (user) => memberIds.includes(user.id) && !EXCLUDED_USER_IDS.includes(user.id),
    );

    if (tag) {
      console.log(`Фильтрация по тегу: ${tag}`);
      if (TAG_TYPE === 'list_tags') {
        participants = participants.filter(
          (user) => user.list_tags && user.list_tags.includes(tag),
        );
      } else if (TAG_TYPE === 'custom_properties') {
        participants = participants.filter(
          (user) =>
            user.custom_properties &&
            user.custom_properties.some((prop) => prop.value === tag),
        );
      }
    }

    participants = participants.map((user) => ({
      id: user.id,
      name:
        `${user.first_name} ${user.last_name}`.trim() || user.email || `User_${user.id}`,
    }));

    console.log('Участники после фильтрации:', JSON.stringify(participants, null, 2));
    return participants;
  } catch (error) {
    console.error('Ошибка в getChatParticipants:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

// Отправка сообщения в чат
async function sendMessage(chatId, text) {
  console.log('Отправка сообщения:', { chatId, text });
  try {
    const response = await axios.post(
      `https://api.pachca.com/api/shared/v1/messages`,
      {
        message: {
          entity_id: chatId,
          content: text,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );
    console.log('Ответ от Pachca:', JSON.stringify(response.data, null, 2));
    return response;
  } catch (error) {
    console.error('Ошибка в sendMessage:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

// Обработка входящих вебхуков
app.post('/webhook', async (req, res) => {
  console.log('Получен вебхук:', JSON.stringify(req.body, null, 2));
  console.log('Заголовки:', JSON.stringify(req.headers, null, 2));

  if (!verifySignature(req)) {
    console.error('Неверная подпись вебхука');
    return res.status(401).send('Invalid signature');
  }

  try {
    const { content, chat_id } = req.body;
    const chatId = chat_id;
    const text = content?.trim();

    console.log('Обработка команды:', { chatId, text });

    if (text && text.startsWith('/group')) {
      const match = text.match(/\/group\s+(\d+)(?:\s+tag:([\p{L}\d_-]+))?/u);
      if (!match) {
        console.log('Неверный формат команды');
        await sendMessage(
          chatId,
          'Укажите размер групп, например: /group 3 или /group 3 tag:Студент',
        );
        return res.status(200).send();
      }

      const groupSize = parseInt(match[1]);
      const tag = match[2] || null;

      if (groupSize < 1) {
        console.log('Недопустимый размер группы:', groupSize);
        await sendMessage(chatId, 'Размер группы должен быть больше 0');
        return res.status(200).send();
      }

      console.log('Получение участников для группы размером:', groupSize, 'тег:', tag);
      const participants = await getChatParticipants(chatId, tag);
      if (participants.length < groupSize) {
        console.log('Недостаточно участников:', participants.length);
        await sendMessage(
          chatId,
          `Недостаточно участников (${participants.length}) для групп по ${groupSize}${
            tag ? ` с тегом ${tag}` : ''
          }`,
        );
        return res.status(200).send();
      }

      console.log('Формирование групп...');
      const groups = createGroups(participants, groupSize);
      let response = `Сформированы группы${tag ? ` для тега ${tag}` : ''}:\n`;
      groups.forEach((group, index) => {
        response += `\nГруппа ${index + 1}:\n`;
        group.forEach((participant, i) => {
          response += `${i + 1}. ${participant.name}\n`;
        });
      });

      console.log('Отправка ответа:', response);
      await sendMessage(chatId, response);
    } else {
      console.log('Команда не распознана:', text);
    }

    res.status(200).send();
  } catch (error) {
    console.error('Ошибка обработки вебхука:', {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).send('Error');
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

module.exports = app;