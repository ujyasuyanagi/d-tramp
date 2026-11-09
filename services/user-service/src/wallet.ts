import { HttpError } from '@dtramp/shared';
import { User } from './models';

/** Повтор списания с тем же id заказа не меняет баланс второй раз. */
export async function debitRide(userId: string, rideId: string, amount: number) {
  const updated = await User.findOneAndUpdate(
    { _id: userId, balance: { $gte: amount }, 'ridePayments.rideId': { $ne: rideId } },
    { $inc: { balance: -amount }, $push: { ridePayments: { rideId, amount, refunded: false } } },
    { new: true },
  );
  if (updated) return updated;
  const user = await User.findById(userId).select('+ridePayments');
  if (!user) throw new HttpError(404, 'Пользователь не найден');
  const payment = user.ridePayments.find((item) => item.rideId === rideId);
  if (payment && !payment.refunded && payment.amount === amount) return user;
  if (payment) throw new HttpError(409, 'Платёж заказа уже отменён или имеет другую сумму');
  throw new HttpError(409, 'Недостаточно средств на балансе');
}

/**
 * Возвращаем только фактически списанную сумму. Маркер возврата и баланс — один
 * документ MongoDB: повтор, потерянный ответ и параллельные отмены безопасны.
 * Отмена до списания оставляет маркер, запрещающий запоздавшее списание.
 */
export async function refundRide(userId: string, rideId: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const user = await User.findById(userId).select('+ridePayments');
    if (!user) throw new HttpError(404, 'Пользователь не найден');
    const payment = user.ridePayments.find((item) => item.rideId === rideId);
    if (payment?.refunded) return user;
    const updated = payment
      ? await User.findOneAndUpdate(
          { _id: userId, ridePayments: { $elemMatch: { rideId, amount: payment.amount, refunded: false } } },
          { $inc: { balance: payment.amount }, $set: { 'ridePayments.$.refunded': true } },
          { new: true },
        )
      : await User.findOneAndUpdate(
          { _id: userId, 'ridePayments.rideId': { $ne: rideId } },
          { $push: { ridePayments: { rideId, amount: 0, refunded: true } } },
          { new: true },
        );
    if (updated) return updated;
  }
  throw new HttpError(503, 'Не удалось завершить возврат, повторите отмену заказа');
}
